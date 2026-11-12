#!/usr/bin/env bash
# propagate-rescue-webhook.sh
#
# Propagates the Rescue Rangers sending address to the whole fleet:
#
#   1. Sets RESCUE_RANGERS_WEBHOOK_URL (the public n8n webhook the client
#      gateways can reach outbound) in each box's environment.
#   2. Sets RESCUE_RANGERS_WEBHOOK_SECRET alongside it, when the operator has it.
#
# This script sets the sending address and secret only. The escalation section in
# AGENTS.md is written only by the onboarding repository's stamper and fleet roll.
#
# Two box types are handled:
#   A. VPS  (8 Hostinger Docker boxes) reached by `ssh root@<ip>`.
#        - host /docker/<project>/.env            (canonical Hostinger env)
#        - container /data/.openclaw/secrets/.env (mirror)
#        - container /data/.openclaw/openclaw.json env.vars (gateway runtime)
#        - docker compose up -d --force-recreate   (only if host .env changed)
#   B. Mac-tunnel clients reached over the Cloudflare tunnel SSH aliases in
#      ~/.ssh/config. No Docker; bare-Mac OpenClaw.
#        - ~/.openclaw/secrets/.env                (env)
#        - ~/.openclaw/openclaw.json env.vars      (gateway runtime)
#        - NO restart. Mac gateway restarts are a separate manual decision
#          (mirrors propagate-rescue-chat-id.sh's stance).
#
# Idempotent:
#   - Skips env writes that already have the correct value.
#   - Backs up a file only when the script is about to change it
#     (.bak-pre-rescue-webhook-<UTC ts>).
#
# Usage:
#   propagate-rescue-webhook.sh [--vps-only|--mac-only] [--dry-run] [WEBHOOK_URL]
#
#   WEBHOOK_URL defaults to the canonical public n8n webhook below. Pass a
#   different URL only if the webhook ever moves.
#
# Hard rules followed:
#   - No em dashes in user-visible output.
#   - Backup before edit on every file modification.
#   - Reads the VPS roster from the same shape as propagate-rescue-chat-id.sh and
#     the Mac roster from ~/.ssh/config rescue-* aliases. Keep both in sync with
#     ~/clawd/accounts/accounts.md when the fleet changes.
#
# This script does NOT touch the operator's own Mac gateway and does NOT touch
# any client's own off-limits Cloudflare account (Track B clients).

set -u
set -o pipefail

# ------------------------------------------------------------------ args ----

VPS_ONLY=0
MAC_ONLY=0
DRY_RUN=0
# RR-017 (2026-09-08): retired /webhook/rescue-rangers replaced by canonical rr-v2-intake.
WEBHOOK_URL_DEFAULT="https://main.blackceoautomations.com/webhook/rr-v2-intake"
WEBHOOK_URL=""

for arg in "$@"; do
  case "${arg}" in
    --vps-only) VPS_ONLY=1 ;;
    --mac-only) MAC_ONLY=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    http*)      WEBHOOK_URL="${arg}" ;;
    *) echo "ERROR: unknown argument '${arg}'"; exit 1 ;;
  esac
done

WEBHOOK_URL="${WEBHOOK_URL:-${WEBHOOK_URL_DEFAULT}}"

if [[ "${VPS_ONLY}" == "1" && "${MAC_ONLY}" == "1" ]]; then
  echo "ERROR: --vps-only and --mac-only are mutually exclusive."
  exit 1
fi

# Basic sanity on the URL.
if ! [[ "${WEBHOOK_URL}" =~ ^https?://[^[:space:]]+$ ]]; then
  echo "ERROR: WEBHOOK_URL looks invalid: ${WEBHOOK_URL}"
  exit 1
fi

TS=$(date -u +%Y%m%d-%H%M%S)
KEY_NAME="RESCUE_RANGERS_WEBHOOK_URL"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519}"
SSH_OPTS=(-i "${SSH_KEY}" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${HOME}/.ssh/known_hosts")
# Mac-tunnel SSH uses the ~/.ssh/config aliases directly (ProxyCommand handles
# cloudflared). BatchMode + accept-new keep it non-interactive; the per-host
# service-token env vars must already be exported (sourced from the secrets .env).
MAC_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new)
SECRETS_ENV="${HOME}/.openclaw/secrets/.env"

log() { printf '%s %s\n' "[$(date -u +%H:%M:%SZ)]" "$*"; }

# Source the operator secrets so CF Access service-token env vars are available
# to the Mac-tunnel ProxyCommands (per-host aliases inject them inline).
if [[ -f "${SECRETS_ENV}" ]]; then
  set -a; # shellcheck disable=SC1090
  source "${SECRETS_ENV}"; set +a
fi

# ------------------------------------------------------------- Fleet roster ----
# The fleet roster (client box labels, IPs, container names, SSH aliases, and
# per-box agent display names) is CLIENT-SPECIFIC and MUST NOT be committed to
# this fleet-wide repo. It is loaded at runtime from operator-local roster files
# that are never checked in. Override the paths with the env vars below.
#
#   Default dir:  ${CLAWD_HOME:-$HOME/clawd}/accounts/
#   VPS roster:   RESCUE_VPS_ROSTER_FILE  (default: <dir>/rescue-vps-roster.txt)
#   Mac roster:   RESCUE_MAC_ROSTER_FILE  (default: <dir>/rescue-mac-roster.txt)
#
# Line formats (pipe-delimited, one box per line):
#   VPS:  client_label|ip|container|compose_project_dir|agent_name
#   Mac:  client_label|ssh_alias|agent_name
#         ssh_alias resolves through ~/.ssh/config (ProxyCommand = cloudflared
#         access ssh). Bare-Mac OpenClaw lives under ~/.openclaw on the remote home.
#
# agent_name is the display name the local agent uses in the escalation payload.
# Blank lines and lines starting with '#' are ignored; omit or comment out any
# opted-out box in the roster file. Keep both files in sync with the operator's
# accounts ledger. The operator's own Mac gateway is intentionally NOT rostered.
CLAWD_HOME="${CLAWD_HOME:-${HOME}/clawd}"
VPS_ROSTER_FILE="${RESCUE_VPS_ROSTER_FILE:-${CLAWD_HOME}/accounts/rescue-vps-roster.txt}"
MAC_ROSTER_FILE="${RESCUE_MAC_ROSTER_FILE:-${CLAWD_HOME}/accounts/rescue-mac-roster.txt}"

_load_roster() {
  # Emit non-blank, non-comment lines from a roster file (empty if absent).
  local file="$1"
  [ -f "${file}" ] || return 0
  grep -vE '^[[:space:]]*(#|$)' "${file}" || true
}

VPS_ROSTER=()
while IFS= read -r _line; do
  [ -n "${_line}" ] && VPS_ROSTER+=("${_line}")
done < <(_load_roster "${VPS_ROSTER_FILE}")

MAC_ROSTER=()
while IFS= read -r _line; do
  [ -n "${_line}" ] && MAC_ROSTER+=("${_line}")
done < <(_load_roster "${MAC_ROSTER_FILE}")

# Warn loudly (never silently no-op) when the in-scope roster is empty: the most
# likely cause is a missing operator-local roster file, not an empty fleet.
if [[ "${MAC_ONLY}" != "1" && "${#VPS_ROSTER[@]}" -eq 0 ]]; then
  echo "WARN: VPS roster empty. Create ${VPS_ROSTER_FILE} (client_label|ip|container|compose_project_dir|agent_name per line) or set RESCUE_VPS_ROSTER_FILE."
fi
if [[ "${VPS_ONLY}" != "1" && "${#MAC_ROSTER[@]}" -eq 0 ]]; then
  echo "WARN: Mac roster empty. Create ${MAC_ROSTER_FILE} (client_label|ssh_alias|agent_name per line) or set RESCUE_MAC_ROSTER_FILE."
fi

# ---------------------------------------------------- remote env updater -----
# Generates a portable POSIX-sh script that, given env vars KEY/VAL/ENV_FILE/
# JSON_FILE, applies the env var to the .env + openclaw.json. Backs up a file
# only when it is about to change it. Echoes a CHANGED= marker so the caller
# knows whether a reload is needed. Used identically by both VPS (inside the
# container, prefixed with `docker exec`) and Mac (direct on the box).
# Pure sh + jq.
remote_apply_body() {
cat <<'BODY'
set -u
ENV_CHANGED=0

# 1. .env
if [ -n "${ENV_FILE}" ]; then
  if [ -f "${ENV_FILE}" ]; then
    if grep -qE "^${KEY}=" "${ENV_FILE}"; then
      if grep -qE "^${KEY}=['\"]?${VAL_RE}['\"]?$" "${ENV_FILE}"; then
        echo "  env: already correct"
      else
        cp "${ENV_FILE}" "${ENV_FILE}.bak-pre-rescue-webhook-${TS}"
        sed -i "s|^${KEY}=.*$|${KEY}='${VAL}'|" "${ENV_FILE}" 2>/dev/null \
          || sed -i '' "s|^${KEY}=.*$|${KEY}='${VAL}'|" "${ENV_FILE}"
        echo "  env: replaced existing entry"
        ENV_CHANGED=1
      fi
    else
      cp "${ENV_FILE}" "${ENV_FILE}.bak-pre-rescue-webhook-${TS}"
      printf "\n%s='%s'\n" "${KEY}" "${VAL}" >> "${ENV_FILE}"
      echo "  env: appended"
      ENV_CHANGED=1
    fi
  else
    echo "  env: ${ENV_FILE} missing; creating"
    mkdir -p "$(dirname "${ENV_FILE}")"
    printf "%s='%s'\n" "${KEY}" "${VAL}" > "${ENV_FILE}"
    ENV_CHANGED=1
  fi
fi

# 2. openclaw.json env.vars
if [ -n "${JSON_FILE}" ] && [ -f "${JSON_FILE}" ]; then
  if command -v jq >/dev/null 2>&1; then
    cur=$(jq -r --arg k "${KEY}" '.env.vars[$k] // empty' "${JSON_FILE}" 2>/dev/null || true)
    if [ "${cur}" = "${VAL}" ]; then
      echo "  json: env.vars already correct"
    else
      cp "${JSON_FILE}" "${JSON_FILE}.bak-pre-rescue-webhook-${TS}"
      jq --arg k "${KEY}" --arg v "${VAL}" \
        '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[$k] = $v' \
        "${JSON_FILE}" > "${JSON_FILE}.tmp.$$" && mv "${JSON_FILE}.tmp.$$" "${JSON_FILE}"
      echo "  json: env.vars patched"
    fi
  else
    echo "  json: WARN jq missing; skipping json patch"
  fi
fi

echo "CHANGED=${ENV_CHANGED}"
BODY
}

# Escape the URL for use inside a sed/grep regex (dots, slashes).
regex_escape() { printf '%s' "$1" | sed -e 's/[.[\*^$/]/\\&/g'; }

VAL_RE=$(regex_escape "${WEBHOOK_URL}")

failures=()
ok=()

# ============================================================ VPS BOXES =======
if [[ "${MAC_ONLY}" != "1" && "${#VPS_ROSTER[@]}" -gt 0 ]]; then
  for entry in "${VPS_ROSTER[@]}"; do
    IFS='|' read -r client ip container compose_dir agent <<< "${entry}"
    log "VPS ${client} (${ip}): starting."

    if [[ "${DRY_RUN}" == "1" ]]; then
      log "VPS ${client}: DRY-RUN (would set ${KEY_NAME}, patch json, recreate if host .env changed)"
      ok+=("${client}(dry)")
      continue
    fi

    body=$(remote_apply_body)

    # Remote orchestration: host .env first, then container files via docker exec.
    remote=$(cat <<REMOTE
set -u
TS="${TS}"
KEY="${KEY_NAME}"
VAL="${WEBHOOK_URL}"
VAL_RE="${VAL_RE}"
CONTAINER="${container}"
COMPOSE_DIR="${compose_dir}"
SECRET_KEY="RESCUE_RANGERS_WEBHOOK_SECRET"
SECRET_VAL="${RESCUE_RANGERS_WEBHOOK_SECRET:-}"

echo "[host .env]"
HOST_CHANGED=0
HOST_ENV="\${COMPOSE_DIR}/.env"
if [ -f "\${HOST_ENV}" ]; then
  if grep -qE "^\${KEY}=" "\${HOST_ENV}"; then
    if grep -qE "^\${KEY}=['\"]?\${VAL_RE}['\"]?\$" "\${HOST_ENV}"; then
      echo "  host .env: already correct"
    else
      cp "\${HOST_ENV}" "\${HOST_ENV}.bak-pre-rescue-webhook-\${TS}"
      sed -i "s|^\${KEY}=.*\$|\${KEY}='\${VAL}'|" "\${HOST_ENV}"
      echo "  host .env: replaced"; HOST_CHANGED=1
    fi
  else
    cp "\${HOST_ENV}" "\${HOST_ENV}.bak-pre-rescue-webhook-\${TS}"
    printf "\n%s='%s'\n" "\${KEY}" "\${VAL}" >> "\${HOST_ENV}"
    echo "  host .env: appended"; HOST_CHANGED=1
  fi
else
  echo "  host .env: missing; creating"; mkdir -p "\${COMPOSE_DIR}"
  printf "%s='%s'\n" "\${KEY}" "\${VAL}" > "\${HOST_ENV}"; HOST_CHANGED=1
fi

echo "[container files]"
docker exec -u node -e TS="\${TS}" -e KEY="\${KEY}" -e VAL="\${VAL}" -e VAL_RE="\${VAL_RE}" \\
  -e ENV_FILE=/data/.openclaw/secrets/.env \\
  -e JSON_FILE=/data/.openclaw/openclaw.json \\
  "\${CONTAINER}" sh -s <<'INNER'
$(remote_apply_body)
INNER

# Propagate RESCUE_RANGERS_WEBHOOK_SECRET BEFORE force-recreate so that HOST_CHANGED
# accumulates both the URL and secret changes, and a single force-recreate picks up both
# from the host .env at container-start time. (Bug fix: previously this block ran AFTER
# the force-recreate check, meaning a fresh run could leave the container env missing the
# secret even though the host .env was correct.)
if [ -n "\${SECRET_VAL}" ]; then
  echo "[secret] propagating \${SECRET_KEY}"
  HOST_ENV="\${COMPOSE_DIR}/.env"
  # RRX-131: decide "already correct" by reading the current line in the shell and
  # comparing strings. The secret never enters the text of a grep, a sed or a
  # docker exec -e argument. A backup is taken only when this block changes the file.
  SECRET_LINE=""
  if [ -f "\${HOST_ENV}" ]; then
    while IFS= read -r _line; do
      case "\${_line}" in
        "\${SECRET_KEY}="*) SECRET_LINE="\${_line}"; break ;;
      esac
    done < "\${HOST_ENV}"
  fi
  SECRET_WANT="\${SECRET_KEY}='\${SECRET_VAL}'"
  if [ "\${SECRET_LINE}" = "\${SECRET_WANT}" ] || [ "\${SECRET_LINE}" = "\${SECRET_KEY}=\${SECRET_VAL}" ]; then
    echo "  host .env: secret already correct"
  elif [ -n "\${SECRET_LINE}" ]; then
    cp "\${HOST_ENV}" "\${HOST_ENV}.bak-pre-rescue-webhook-\${TS}"
    _tmp="\${HOST_ENV}.tmp.\$\$"
    while IFS= read -r _line || [ -n "\${_line}" ]; do
      case "\${_line}" in
        "\${SECRET_KEY}="*) printf '%s\n' "\${SECRET_WANT}" ;;
        *) printf '%s\n' "\${_line}" ;;
      esac
    done < "\${HOST_ENV}" > "\${_tmp}"
    mv "\${_tmp}" "\${HOST_ENV}"
    echo "  host .env: secret replaced"; HOST_CHANGED=1
  else
    if [ -f "\${HOST_ENV}" ]; then cp "\${HOST_ENV}" "\${HOST_ENV}.bak-pre-rescue-webhook-\${TS}"; fi
    printf "\n%s='%s'\n" "\${SECRET_KEY}" "\${SECRET_VAL}" >> "\${HOST_ENV}"
    echo "  host .env: secret appended"; HOST_CHANGED=1
  fi
  # Also patch the container's openclaw.json (persistent bind-mount) so the secret is
  # available via OpenClaw's env.vars even before the next force-recreate. The value
  # arrives on stdin, never as a docker exec -e argument (RRX-131).
  printf '%s' "\${SECRET_VAL}" | docker exec -i -u node "\${CONTAINER}" sh -c '
    IFS= read -r SV || true
    SK="RESCUE_RANGERS_WEBHOOK_SECRET"
    if command -v jq >/dev/null 2>&1; then
      cur=\$(jq -r --arg k "$SK" ".env.vars[\$k] // empty" /data/.openclaw/openclaw.json 2>/dev/null || true)
      if [ "$cur" = "$SV" ]; then
        echo "  container openclaw.json: secret already correct"
      else
        jq --arg k "$SK" --arg v "$SV" \\
          ".env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\$k] = \$v" \\
          /data/.openclaw/openclaw.json > /data/.openclaw/openclaw.json.tmp \\
          && mv /data/.openclaw/openclaw.json.tmp /data/.openclaw/openclaw.json \\
          && echo "  container openclaw.json: secret patched"
      fi
    else echo "  container openclaw.json: jq missing; skipping"; fi
  ' 2>/dev/null || true
else
  echo "[secret] RESCUE_RANGERS_WEBHOOK_SECRET not in operator env; skipping secret propagation for this box (will be set on next install/update)"
fi

if [ "\${HOST_CHANGED}" = "1" ]; then
  echo "[reload] host .env changed; docker compose up -d --force-recreate"
  cd "\${COMPOSE_DIR}" && docker compose up -d --force-recreate 2>&1 | tail -6
else
  echo "[reload] host .env unchanged; skipping force-recreate"
fi

echo "[verify] container env:"
# RRX-131: print present or absent for each name and never a value.
_url_state=\$(docker exec -u node "\${CONTAINER}" sh -c '[ -n "\${RESCUE_RANGERS_WEBHOOK_URL:-}" ] && echo present || echo absent' 2>/dev/null) || _url_state=unknown
_secret_state=\$(docker exec -u node "\${CONTAINER}" sh -c '[ -n "\${RESCUE_RANGERS_WEBHOOK_SECRET:-}" ] && echo present || echo absent' 2>/dev/null) || _secret_state=unknown
echo "  \${KEY}: \${_url_state}"
echo "  \${SECRET_KEY}: \${_secret_state}"
REMOTE
)

    if ssh "${SSH_OPTS[@]}" "root@${ip}" "bash -s" <<< "${remote}"; then
      log "VPS ${client}: OK"
      ok+=("${client}")
    else
      log "VPS ${client}: FAILED"
      failures+=("vps:${client}")
    fi
  done
fi

# ===================================================== MAC-TUNNEL BOXES ========
if [[ "${VPS_ONLY}" != "1" && "${#MAC_ROSTER[@]}" -gt 0 ]]; then
  for entry in "${MAC_ROSTER[@]}"; do
    IFS='|' read -r client alias agent <<< "${entry}"
    log "MAC ${client} (${alias}): starting."

    if [[ "${DRY_RUN}" == "1" ]]; then
      log "MAC ${client}: DRY-RUN (would set ${KEY_NAME} + patch json; NO restart)"
      ok+=("${client}(dry)")
      continue
    fi

    body=$(remote_apply_body)

    # Bare-Mac: env files resolve against the remote home directory.
    remote=$(cat <<REMOTE
set -u
export TS="${TS}"
export KEY="${KEY_NAME}"
export VAL="${WEBHOOK_URL}"
export VAL_RE="${VAL_RE}"
SECRET_KEY="RESCUE_RANGERS_WEBHOOK_SECRET"
SECRET_VAL="${RESCUE_RANGERS_WEBHOOK_SECRET:-}"
HOME_DIR="\${HOME}"
export ENV_FILE="\${HOME_DIR}/.openclaw/secrets/.env"
export JSON_FILE="\${HOME_DIR}/.openclaw/openclaw.json"
$(remote_apply_body)
echo "[verify] env:"
grep -E "^\${KEY}=" "\${ENV_FILE}" 2>/dev/null || echo "  (env var not found in .env)"

# Propagate RESCUE_RANGERS_WEBHOOK_SECRET to this Mac box's env + openclaw.json.
# RRX-131: compare strings in the shell; the secret never enters the text of a
# grep or a sed command, and a backup is taken only when a file is about to change.
if [ -n "\${SECRET_VAL}" ]; then
  echo "[secret] propagating \${SECRET_KEY}"
  SECRET_LINE=""
  if [ -f "\${ENV_FILE}" ]; then
    while IFS= read -r _line; do
      case "\${_line}" in
        "\${SECRET_KEY}="*) SECRET_LINE="\${_line}"; break ;;
      esac
    done < "\${ENV_FILE}"
  fi
  SECRET_WANT="\${SECRET_KEY}='\${SECRET_VAL}'"
  if [ "\${SECRET_LINE}" = "\${SECRET_WANT}" ] || [ "\${SECRET_LINE}" = "\${SECRET_KEY}=\${SECRET_VAL}" ]; then
    echo "  .env: secret already correct"
  elif [ -n "\${SECRET_LINE}" ]; then
    cp "\${ENV_FILE}" "\${ENV_FILE}.bak-pre-rescue-webhook-\${TS}"
    _tmp="\${ENV_FILE}.tmp.\$\$"
    while IFS= read -r _line || [ -n "\${_line}" ]; do
      case "\${_line}" in
        "\${SECRET_KEY}="*) printf '%s\n' "\${SECRET_WANT}" ;;
        *) printf '%s\n' "\${_line}" ;;
      esac
    done < "\${ENV_FILE}" > "\${_tmp}"
    mv "\${_tmp}" "\${ENV_FILE}"
    echo "  .env: secret replaced"
  else
    if [ -f "\${ENV_FILE}" ]; then cp "\${ENV_FILE}" "\${ENV_FILE}.bak-pre-rescue-webhook-\${TS}"; fi
    printf "\n%s='%s'\n" "\${SECRET_KEY}" "\${SECRET_VAL}" >> "\${ENV_FILE}"
    echo "  .env: secret appended"
  fi
  if command -v jq >/dev/null 2>&1 && [ -f "\${JSON_FILE}" ]; then
    _cur=\$(jq -r --arg k "\${SECRET_KEY}" '.env.vars[\$k] // empty' "\${JSON_FILE}" 2>/dev/null || true)
    if [ "\${_cur}" = "\${SECRET_VAL}" ]; then
      echo "  openclaw.json: secret already correct"
    else
      cp "\${JSON_FILE}" "\${JSON_FILE}.bak-pre-rescue-webhook-\${TS}"
      jq --arg k "\${SECRET_KEY}" --arg v "\${SECRET_VAL}" \\
        '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\$k] = \$v' \\
        "\${JSON_FILE}" > "\${JSON_FILE}.tmp.\$\$" && mv "\${JSON_FILE}.tmp.\$\$" "\${JSON_FILE}"
      echo "  openclaw.json: secret patched"
    fi
  else
    echo "  openclaw.json: jq missing or json not found; skipping json patch"
  fi
else
  echo "[secret] RESCUE_RANGERS_WEBHOOK_SECRET not in operator env; skipping secret for this box (will be set on next install/update)"
fi
echo "[note] Mac gateway NOT restarted (separate manual decision)."
REMOTE
)

    # Mac-tunnel commands must run through a login shell so node/openclaw is on
    # PATH; wrap in `zsh -lc`. The body itself is POSIX-sh and runs fine there.
    if ssh "${MAC_SSH_OPTS[@]}" "${alias}" "zsh -lc 'bash -s'" <<< "${remote}"; then
      log "MAC ${client}: OK"
      ok+=("${client}")
    else
      log "MAC ${client}: FAILED (tunnel down? service token? FileVault locked?)"
      failures+=("mac:${client}")
    fi
  done
fi

# ===================================================================== SUMMARY =
echo
echo "==================================================="
echo "Rescue webhook propagation summary (UTC ${TS})"
echo "  webhook: ${KEY_NAME}=${WEBHOOK_URL}"
echo "  scope:   $([[ ${VPS_ONLY} == 1 ]] && echo VPS-only || ([[ ${MAC_ONLY} == 1 ]] && echo Mac-only || echo VPS+Mac))"
echo "  dry-run: ${DRY_RUN}"
echo "  ok:      ${ok[*]:-none}"
if [[ ${#failures[@]} -eq 0 ]]; then
  echo "  status:  ALL OK"
  echo "==================================================="
  exit 0
else
  echo "  failed:  ${failures[*]}"
  echo "==================================================="
  exit 2
fi
