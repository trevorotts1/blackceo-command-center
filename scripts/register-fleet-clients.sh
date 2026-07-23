#!/usr/bin/env bash
set -euo pipefail

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

# Expand ${VAR} references in a string. Unset variables expand to the empty
# string. Prefers envsubst when available; falls back to pure bash.
expand_env() {
  local val="$1"
  if command -v envsubst &>/dev/null; then
    printf '%s' "$val" | envsubst
    return 0
  fi
  # Pure-bash fallback: replace each ${VAR} token with its value.
  local result="$val"
  local re='\$\{([A-Za-z_][A-Za-z0-9_]*)\}'
  while [[ "$result" =~ $re ]]; do
    local var_name="${BASH_REMATCH[1]}"
    local var_value="${!var_name:-}"
    result="${result//\$\{$var_name\}/$var_value}"
  done
  printf '%s' "$result"
}

# Fetch the set of already-registered client names from GET /api/clients.
# In dry-run mode this is skipped (an empty set is returned) so the preview
# still lists every roster entry.
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

# ---------------------------------------------------------------------------
# Parse CLI args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --roster)
      if [[ $# -lt 2 ]]; then
        echo "Error: --roster requires a file path" >&2
        exit 1
      fi
      ROSTER_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      echo "Use --help for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate roster file
# ---------------------------------------------------------------------------

if [[ ! -f "$ROSTER_FILE" ]]; then
  echo "Error: Fleet roster not found at $ROSTER_FILE" >&2
  echo "" >&2
  echo "Create this file using the INI-like format described in --help." >&2
  echo "Example stanza:" >&2
  echo "" >&2
  echo "  [Acme Consulting]" >&2
  echo "  gateway_url=wss://acme.example.com:18789" >&2
  echo "  gateway_token=\${ACME_GATEWAY_TOKEN}" >&2
  echo "  cf_access_client_id=\${ACME_CF_ID}" >&2
  echo "  cf_access_client_secret=\${ACME_CF_SECRET}" >&2
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

# Parser state for the current client section
CURRENT_NAME=""
CURRENT_GATEWAY_URL=""
CURRENT_GATEWAY_TOKEN=""
CURRENT_CF_ID=""
CURRENT_CF_SECRET=""
CURRENT_WORKSPACE=""
CURRENT_SSH=""

# Reset parser state between sections.
reset_current() {
  CURRENT_NAME=""
  CURRENT_GATEWAY_URL=""
  CURRENT_GATEWAY_TOKEN=""
  CURRENT_CF_ID=""
  CURRENT_CF_SECRET=""
  CURRENT_WORKSPACE=""
  CURRENT_SSH=""
}

# Register (or dry-run print) the client held in CURRENT_* vars, then reset.
flush_and_register() {
  if [[ -z "$CURRENT_NAME" ]]; then
    return 0
  fi

  local name="$CURRENT_NAME"

  # Expand env var references embedded in each value.
  local gw_url
  gw_url="$(expand_env "$CURRENT_GATEWAY_URL")"

  local gw_token=""
  local cf_id=""
  local cf_secret=""
  local gw_token_raw="$CURRENT_GATEWAY_TOKEN"
  local cf_id_raw="$CURRENT_CF_ID"
  local cf_secret_raw="$CURRENT_CF_SECRET"

  if [[ -n "$gw_token_raw" ]]; then
    gw_token="$(expand_env "$gw_token_raw")"
  fi
  if [[ -n "$cf_id_raw" ]]; then
    cf_id="$(expand_env "$cf_id_raw")"
  fi
  if [[ -n "$cf_secret_raw" ]]; then
    cf_secret="$(expand_env "$cf_secret_raw")"
  fi

  local workspace="$(expand_env "${CURRENT_WORKSPACE:-}")"
  local ssh="$(expand_env "${CURRENT_SSH:-}")"

  # --- Gate: missing gateway_url ---
  if [[ -z "$gw_url" ]]; then
    echo "  [WARN] $name — missing gateway_url, skipping" >&2
    WARNED=$((WARNED + 1))
    reset_current
    return 0
  fi

  # --- Gate: missing credentials (warn but do not crash) ---
  # If an env var name is specified but expands to empty, the credential is
  # effectively missing. Warn so the operator knows to fix it, but don't
  # block the rest of the fleet.
  local missing_creds=()
  if [[ -n "$gw_token_raw" && -z "$gw_token" ]]; then
    missing_creds+=("gateway_token (env: $gw_token_raw)")
  fi
  if [[ -n "$cf_id_raw" && -z "$cf_id" ]]; then
    missing_creds+=("cf_access_client_id (env: $cf_id_raw)")
  fi
  if [[ -n "$cf_secret_raw" && -z "$cf_secret" ]]; then
    missing_creds+=("cf_access_client_secret (env: $cf_secret_raw)")
  fi
  if [[ ${#missing_creds[@]} -gt 0 ]]; then
    local joined
    joined="$(printf '%s, ' "${missing_creds[@]}")"
    joined="${joined%, }"
    echo "  [WARN] $name — credential env var(s) not set: $joined" >&2
  fi

  # --- Idempotency check: skip if already registered ---
  if echo "$EXISTING_NAMES" | grep -qFx "$name" 2>/dev/null; then
    echo "  [SKIP] $name — already registered"
    SKIPPED=$((SKIPPED + 1))
    reset_current
    return 0
  fi

  # --- Dry run ---
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] $name"
    echo "    gateway_url:             $gw_url"
    [[ -n "$gw_token" ]] && echo "    gateway_token:            (set)" || echo "    gateway_token:            (not set)"
    [[ -n "$cf_id" ]]    && echo "    cf_access_client_id:      (set)" || echo "    cf_access_client_id:      (not set)"
    [[ -n "$cf_secret" ]] && echo "    cf_access_client_secret:  (set)" || echo "    cf_access_client_secret:  (not set)"
    [[ -n "$workspace" ]] && echo "    workspace_root:           $workspace"
    [[ -n "$ssh" ]]       && echo "    ssh_target:               $ssh"
    REGISTERED=$((REGISTERED + 1))
    reset_current
    return 0
  fi

  # --- Build JSON payload (python3 — bash cannot safely construct JSON) ---
  local payload
  payload="$(python3 -c "
import json, sys
p = {'name': sys.argv[1]}
if sys.argv[2]:
    p['gateway_url'] = sys.argv[2]
if sys.argv[3]:
    p['gateway_token'] = sys.argv[3]
if sys.argv[4]:
    p['cf_access_client_id'] = sys.argv[4]
if sys.argv[5]:
    p['cf_access_client_secret'] = sys.argv[5]
if sys.argv[6]:
    p['workspace_root'] = sys.argv[6]
if sys.argv[7]:
    p['ssh_target'] = sys.argv[7]
print(json.dumps(p))
" "$name" "$gw_url" "$gw_token" "$cf_id" "$cf_secret" "$workspace" "$ssh")"

  # --- POST to API ---
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 15 \
    -X POST "${API_URL}" \
    -H 'Content-Type: application/json' \
    -d "$payload" 2>/dev/null || echo "000")"

  if [[ "$code" == "201" ]]; then
    echo "  [OK]   $name — registered"
    REGISTERED=$((REGISTERED + 1))
  else
    echo "  [FAIL] $name — HTTP $code"
    WARNED=$((WARNED + 1))
  fi

  reset_current
}

# ---------------------------------------------------------------------------
# Parse the roster file line by line
# ---------------------------------------------------------------------------

reset_current

while IFS= read -r line || [[ -n "$line" ]]; do
  # Strip carriage returns (Windows line endings).
  line="${line%$'\r'}"

  # Blank line → flush the current section.
  if [[ -z "${line//[[:space:]]/}" ]]; then
    flush_and_register
    continue
  fi

  # Comment line.
  if [[ "$line" =~ ^[[:space:]]*# ]]; then
    continue
  fi

  # Section header: [Client Name]
  if [[ "$line" =~ ^\[(.+)\]$ ]]; then
    flush_and_register
    CURRENT_NAME="${BASH_REMATCH[1]}"
    continue
  fi

  # Key=Value
  if [[ "$line" =~ ^([A-Za-z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    local_key="${BASH_REMATCH[1]}"
    local_value="${BASH_REMATCH[2]}"
    # Trim trailing whitespace.
    local_value="${local_value%"${local_value##*[![:space:]]}"}"

    case "$local_key" in
      gateway_url)           CURRENT_GATEWAY_URL="$local_value" ;;
      gateway_token)         CURRENT_GATEWAY_TOKEN="$local_value" ;;
      cf_access_client_id)   CURRENT_CF_ID="$local_value" ;;
      cf_access_client_secret) CURRENT_CF_SECRET="$local_value" ;;
      workspace_root)        CURRENT_WORKSPACE="$local_value" ;;
      ssh_target)            CURRENT_SSH="$local_value" ;;
      *) ;;  # Silently ignore unknown keys for forward-compatibility.
    esac
  fi
done < "$ROSTER_FILE"

# Flush the final section (if any).
flush_and_register

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==> Done: $REGISTERED registered, $SKIPPED skipped, $WARNED warnings"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> This was a dry run. Re-run without --dry-run to register these clients."
fi

if [[ "$WARNED" -gt 0 && "$DRY_RUN" != "true" ]]; then
  exit 1
fi

exit 0
