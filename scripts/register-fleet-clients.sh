#!/usr/bin/env bash
# register-fleet-clients.sh — Register remote client boxes from a fleet roster.
#
# Reads a fleet roster file (INI-like sections) and POSTs each client to the
# local Command Center API endpoint POST /api/clients. Designed to be repeatable
# and idempotent: existing clients (matched by name) are skipped without
# duplicate insertion.
#
# CREDENTIALS: No credential is hardcoded. Every secret value is read from the
# environment at runtime by expanding ${VAR} references in the roster file.
# A roster entry whose credential env vars are missing is skipped with a
# warning, not a crash.
#
# Roster format (stored at $FLEET_ROSTER or ~/.openclaw/fleet-roster.txt):
#
#   [Client Display Name]
#   gateway_url=wss://box.example.com:18789
#   gateway_token=${NAME_OF_ENV_VAR}
#   cf_access_client_id=${NAME_OF_ENV_VAR}
#   cf_access_client_secret=${NAME_OF_ENV_VAR}
#   workspace_root=/path/on/box      (optional)
#   ssh_target=user@host             (optional)
#
#   Blank lines separate sections. Lines starting with # are comments.
#
# Usage:
#   ./scripts/register-fleet-clients.sh                 # register all
#   ./scripts/register-fleet-clients.sh --dry-run        # print what WOULD register
#   ./scripts/register-fleet-clients.sh --roster /path   # custom roster path
#
# Environment:
#   FLEET_ROSTER   Path to the fleet roster file (default: ~/.openclaw/fleet-roster.txt)
#   CC_URL         Base URL of the Command Center (default: http://127.0.0.1:3000)
#
# Named Stop: actually applying (POSTing to live CC) requires Trevor's confirmation.
# The builder creates this script and marks the ticket ready-to-apply.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_URL="${CC_URL:-http://127.0.0.1:3000}"
API_URL="${CC_URL}/api/clients"

DRY_RUN=false
ROSTER_FILE="${FLEET_ROSTER:-${HOME}/.openclaw/fleet-roster.txt}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--roster FILE]

Register remote client boxes from a fleet roster via POST /api/clients.

Options:
  --dry-run     Print each client that would be registered without making
                any API call.
  --roster FILE Path to the fleet roster file.
                Default: ~/.openclaw/fleet-roster.txt (overridable with
                \$FLEET_ROSTER).
  -h, --help    Show this message.

Environment:
  FLEET_ROSTER   Path to the fleet roster file.
  CC_URL         Base URL of the Command Center (default: http://127.0.0.1:3000).

Roster format (INI-like, blank-line separated):
  [Client Display Name]
  gateway_url=wss://host:port
  gateway_token=\${ENV_VAR_NAME}
  cf_access_client_id=\${ENV_VAR_NAME}
  cf_access_client_secret=\${ENV_VAR_NAME}
  workspace_root=/optional/path
  ssh_target=user@host
EOF
  exit 0
}

expand_env() {
  local val="$1"
  if command -v envsubst &>/dev/null; then
    printf '%s' "$val" | envsubst
    return 0
  fi
  local result="$val"
  local re='\$\{([A-Za-z_][A-Za-z0-9_]*)\}'
  while [[ "$result" =~ $re ]]; do
    local var_name="${BASH_REMATCH[1]}"
    local var_value="${!var_name:-}"
    result="${result//\$\{$var_name\}/$var_value}"
  done
  printf '%s' "$result"
}

fetch_existing_names() {
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  local resp
  resp="$(curl -sS --connect-timeout 5 --max-time 10 "${CC_URL}/api/clients" 2>/dev/null || true)"
  if [[ -z "$resp" ]]; then
    echo "Warning: Could not reach ${CC_URL}/api/clients to check existing clients. All entries will be treated as new." >&2
    return 0
  fi
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    clients = data.get('clients', [])
    for c in clients:
        print(c.get('name', ''))
except Exception:
    pass
" <<< "$resp" 2>/dev/null || true
}

resolve_credential() {
  local label="$1"
  local raw_val="$2"
  local client_name="$3"
  local env_name="$4"
  local resolved
  resolved="$(expand_env "$raw_val")"
  if [[ -z "$resolved" ]]; then
    echo "  [WARN] ${client_name} — ${label} (env: ${env_name}) not set, skipping" >&2
    return 1
  fi
  printf '%s' "$resolved"
  return 0
}

# ---------------------------------------------------------------------------
# Parse CLI args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --roster)  ROSTER_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Error: Unknown option: $1" >&2; echo "Use --help for usage." >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate roster file
# ---------------------------------------------------------------------------

if [[ ! -f "$ROSTER_FILE" ]]; then
  echo "Error: Fleet roster not found at $ROSTER_FILE" >&2
  echo "" >&2
  echo "Create this file using the INI-like format:" >&2
  echo "  [Client Name]" >&2
  echo "  gateway_url=wss://host:port" >&2
  echo "  gateway_token=\${ENV_VAR_NAME}" >&2
  echo "  cf_access_client_id=\${ENV_VAR_NAME}" >&2
  echo "  cf_access_client_secret=\${ENV_VAR_NAME}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "==> Fleet roster: $ROSTER_FILE"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> DRY RUN — no API calls will be made"
fi
echo ""

EXISTING_NAMES="$(fetch_existing_names)"

REGISTERED=0
SKIPPED=0
WARNED=0

CURRENT_NAME=""
CURRENT_GATEWAY_URL=""
CURRENT_GATEWAY_TOKEN=""
CURRENT_CF_ID=""
CURRENT_CF_SECRET=""
CURRENT_WORKSPACE=""
CURRENT_SSH=""

reset_current() {
  CURRENT_NAME=""
  CURRENT_GATEWAY_URL=""
  CURRENT_GATEWAY_TOKEN=""
  CURRENT_CF_ID=""
  CURRENT_CF_SECRET=""
  CURRENT_WORKSPACE=""
  CURRENT_SSH=""
}

flush_and_register() {
  if [[ -z "$CURRENT_NAME" ]]; then
    return 0
  fi

  local name="$CURRENT_NAME"
  local gw_url
  gw_url="$(expand_env "$CURRENT_GATEWAY_URL")"

  if [[ -z "$gw_url" ]]; then
    echo "  [WARN] $name — missing gateway_url, skipping" >&2
    WARNED=$((WARNED + 1))
    reset_current
    return 0
  fi

  local gw_token=""
  local cf_id=""
  local cf_secret=""

  if [[ -n "$CURRENT_GATEWAY_TOKEN" ]]; then
    gw_token="$(resolve_credential "gateway_token" "$CURRENT_GATEWAY_TOKEN" "$name" "$CURRENT_GATEWAY_TOKEN")" || true
  fi
  if [[ -n "$CURRENT_CF_ID" ]]; then
    cf_id="$(resolve_credential "cf_access_client_id" "$CURRENT_CF_ID" "$name" "$CURRENT_CF_ID")" || true
  fi
  if [[ -n "$CURRENT_CF_SECRET" ]]; then
    cf_secret="$(resolve_credential "cf_access_client_secret" "$CURRENT_CF_SECRET" "$name" "$CURRENT_CF_SECRET")" || true
  fi

  local has_gw_creds=false
  local has_cf_creds=false
  [[ -n "$gw_token" ]] && has_gw_creds=true
  [[ -n "$cf_id" && -n "$cf_secret" ]] && has_cf_creds=true

  if [[ "$has_gw_creds" == "false" && "$has_cf_creds" == "false" ]]; then
    echo "  [WARN] $name — no credentials resolved (gateway_token or cf_access pair required), skipping" >&2
    WARNED=$((WARNED + 1))
    reset_current
    return 0
  fi

  local workspace="$(expand_env "${CURRENT_WORKSPACE:-}")"
  local ssh="$(expand_env "${CURRENT_SSH:-}")"

  # Idempotency: skip if name already exists
  if echo "$EXISTING_NAMES" | grep -qxF "$name" 2>/dev/null; then
    echo "  [SKIP] $name — already registered"
    SKIPPED=$((SKIPPED + 1))
    reset_current
    return 0
  fi

  # Dry-run: only print
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] $name"
    echo "    gateway_url:             $gw_url"
    echo "    gateway_token:            $([[ -n "$gw_token" ]] && echo '(set)' || echo '(not set)')"
    echo "    cf_access_client_id:      $([[ -n "$cf_id" ]] && echo '(set)' || echo '(not set)')"
    echo "    cf_access_client_secret:  $([[ -n "$cf_secret" ]] && echo '(set)' || echo '(not set)')"
    [[ -n "$workspace" ]] && echo "    workspace_root:           $workspace"
    [[ -n "$ssh" ]] && echo "    ssh_target:               $ssh"
    echo ""
    reset_current
    return 0
  fi

  # Live: build payload and POST
  local payload
  payload="$(python3 -c "
import json, sys
p = {'name': sys.argv[1]}
gw_url = sys.argv[2]
if gw_url: p['gateway_url'] = gw_url
gw_token = sys.argv[3]
if gw_token: p['gateway_token'] = gw_token
cf_id = sys.argv[4]
if cf_id: p['cf_access_client_id'] = cf_id
cf_secret = sys.argv[5]
if cf_secret: p['cf_access_client_secret'] = cf_secret
ws = sys.argv[6]
if ws: p['workspace_root'] = ws
ssh = sys.argv[7]
if ssh: p['ssh_target'] = ssh
json.dump(p, sys.stdout)
" "$name" "$gw_url" "$gw_token" "$cf_id" "$cf_secret" "$workspace" "$ssh" 2>/dev/null)"

  local http_code
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "${API_URL}" 2>/dev/null || echo '000')"

  if [[ "$http_code" == "201" ]]; then
    echo "  [OK]    $name — registered (HTTP 201)"
    REGISTERED=$((REGISTERED + 1))
  elif [[ "$http_code" == "000" ]]; then
    echo "  [FAIL]  $name — connection failed (is the CC API running? ${API_URL})" >&2
  else
    echo "  [FAIL]  $name — HTTP $http_code" >&2
  fi

  reset_current
}

while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue
  [[ "$line" == \#* ]] && continue

  if [[ "$line" =~ ^\[([^]]+)\]$ ]]; then
    flush_and_register
    CURRENT_NAME="${BASH_REMATCH[1]}"
    continue
  fi

  if [[ "$line" =~ ^([A-Za-z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    section_key="${BASH_REMATCH[1]}"
    section_value="${BASH_REMATCH[2]}"
    section_value="${section_value%"${section_value##*[![:space:]]}"}"
    case "$section_key" in
      gateway_url)             CURRENT_GATEWAY_URL="$section_value" ;;
      gateway_token)           CURRENT_GATEWAY_TOKEN="$section_value" ;;
      cf_access_client_id)     CURRENT_CF_ID="$section_value" ;;
      cf_access_client_secret) CURRENT_CF_SECRET="$section_value" ;;
      workspace_root)          CURRENT_WORKSPACE="$section_value" ;;
      ssh_target)              CURRENT_SSH="$section_value" ;;
      *) ;;
    esac
  fi
done < "$ROSTER_FILE"

flush_and_register

echo ""
echo "========================================"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  DRY RUN COMPLETE — no API calls made"
  echo "  Skipped / warnings: $WARNED"
else
  echo "  REGISTRATION COMPLETE"
  echo "  Newly registered:    $REGISTERED"
  echo "  Already present:     $SKIPPED"
  echo "  Skipped / warnings:  $WARNED"
  echo "  Target:              $API_URL"
fi
echo "========================================"
