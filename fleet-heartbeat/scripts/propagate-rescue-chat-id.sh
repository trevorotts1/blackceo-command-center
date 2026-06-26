#!/usr/bin/env bash
# propagate-rescue-chat-id.sh
#
# Propagates RESCUE_RANGERS_HELP_CHAT_ID to:
#   1. Mac (~/.openclaw/secrets/.env + ~/.openclaw/openclaw.json env.vars)
#   2. Each fleet VPS (/data/.openclaw/secrets/.env + /data/.openclaw/openclaw.json env.vars)
#   3. Force-recreates each VPS's docker compose stack so the new env var
#      actually loads (docker compose restart does NOT reload env_file changes).
#
# Idempotent:
#   - Skips boxes that already have the correct value in BOTH the .env and
#     openclaw.json.
#   - On any file write, takes a .bak-pre-rescue-chat-id-<UTC ts> backup first.
#
# Usage:
#   propagate-rescue-chat-id.sh <chat-id>
#
# Example:
#   propagate-rescue-chat-id.sh -1001234567890
#
# Does NOT touch Trevor's Mac gateway service (per the master-allowed restart
# rule; Mac gateway restarts are a separate manual decision).
#
# Hard rules followed:
#   - No em dashes in user-visible output.
#   - Backup before edit on every file modification.
#   - Reads roster from ~/clawd/accounts/accounts.md indirectly via this
#     script's local ROSTER constant (sourced from the heartbeat roster shape).
#     If you add a new VPS, update both this ROSTER and probe-fleet.sh.

set -u
set -o pipefail

CHAT_ID="${1:-}"
if [[ -z "${CHAT_ID}" ]]; then
  echo "ERROR: missing chat_id argument."
  echo "Usage: $0 <chat-id>"
  echo "Get the chat_id by following ~/clawd/fleet-heartbeat/rescue-rangers-setup.md steps 1-5."
  exit 1
fi

# Basic sanity check: Telegram group chat ids are negative integers, often -100<digits>.
if ! [[ "${CHAT_ID}" =~ ^-?[0-9]+$ ]]; then
  echo "ERROR: chat_id must be an integer (got: ${CHAT_ID})."
  exit 1
fi

TS=$(date -u +%Y%m%d-%H%M%S)
SSH_KEY="${SSH_KEY:-/Users/blackceomacmini/.ssh/id_ed25519}"
SSH_OPTS=(-i "${SSH_KEY}" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts)
# Mac-tunnel SSH goes through the ProxyCommand in ~/.ssh/config; no direct IP.
MAC_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new)
KEY_NAME="RESCUE_RANGERS_HELP_CHAT_ID"
SECRETS_ENV="${HOME}/.openclaw/secrets/.env"

# Source operator secrets so CF Access service-token env vars are available
# for tunnel ProxyCommands (required for non-interactive cloudflared access).
if [[ -f "${SECRETS_ENV}" ]]; then
  set -a; # shellcheck disable=SC1090
  source "${SECRETS_ENV}"; set +a
fi

# Roster: client_label|ip|container|compose_project_dir
# Keep in sync with ~/clawd/accounts/accounts.md and scripts/probe-fleet.sh.
ROSTER=(
  "corey|187.77.204.227|openclaw-hy5t-openclaw-1|/docker/openclaw-hy5t"
  "maria-anderson|187.77.10.144|openclaw-qxqt-openclaw-1|/docker/openclaw-qxqt"
  "beverly-sanders|72.62.170.43|openclaw-0ht9-openclaw-1|/docker/openclaw-0ht9"
  "evelyn-bethune|2.24.85.21|openclaw-c54p-openclaw-1|/docker/openclaw-c54p"
  "angela-t|187.77.9.130|openclaw-prji-openclaw-1|/docker/openclaw-prji"
  "angeleen|187.77.223.62|openclaw-lydh-openclaw-1|/docker/openclaw-lydh"
  "monique-tucker|177.7.42.223|openclaw-jdbv-openclaw-1|/docker/openclaw-jdbv"
  "lyric-hawkins|187.127.251.97|openclaw-4pkz-openclaw-1|/docker/openclaw-4pkz"
)

# Mac-tunnel client roster: client_label|ssh_alias
# Mirrors the MAC_ROSTER in propagate-rescue-webhook.sh (keep in sync).
# Trevor's own Mac is intentionally excluded (handled separately above).
# Maria Anderson Mac intentionally omitted pending VPS/Mac alias clarification.
MAC_ROSTER=(
  "teresa-pelham|rescue-teresa-pelham"
  "kofi-bryant|rescue-kofi-bryant"
  "cassandra-henriquez|rescue-cassandra-henriquez"
  "karen-vaughn|rescue-karen-vaughn"
  "jill-bulluck|rescue-jill-bulluck"
  "sheila-reynolds|rescue-sheila-reynolds"
  "aurelia-gardner|rescue-aurelia-gardner"
  "lyric-hawkins-mac|rescue-lyric-hawkins"
  "leanne-dolce|rescue-leanne-dolce"
  "sonatta-camara|rescue-sonatta-camara"
  "talaya-kelley|rescue-talaya-kelley"
  "stephanie-wall|rescue-stephanie-wall"
  "jocelyn-mcclure|rescue-jocelyn-mcclure"
  "barret-matthews|rescue-barret-matthews"
  "barret-matthews-mini-2026|rescue-barrett-matthews-mini-2026"
  "christy-staples|rescue-christy-staples"
  "erin-garrett|rescue-erin-garrett"
  "jennifer-allen|rescue-jennifer-allen"
  "star-bobatoon|rescue-star-bobatoon"
)

log() { printf '%s %s\n' "[$(date -u +%H:%M:%SZ)]" "$*"; }

# ---------- Mac side ----------

mac_env=~/.openclaw/secrets/.env
mac_json=~/.openclaw/openclaw.json

log "Mac: writing ${KEY_NAME}=${CHAT_ID} into ${mac_env}"

if [[ -f "${mac_env}" ]]; then
  cp "${mac_env}" "${mac_env}.bak-pre-rescue-chat-id-${TS}"
  if grep -qE "^${KEY_NAME}=" "${mac_env}"; then
    if grep -qE "^${KEY_NAME}=['\"]?${CHAT_ID}['\"]?\$" "${mac_env}"; then
      log "Mac: .env already has correct value, skipping rewrite."
    else
      # Cross-platform sed in-place (BSD on macOS).
      sed -i '' "s|^${KEY_NAME}=.*\$|${KEY_NAME}='${CHAT_ID}'|" "${mac_env}"
      log "Mac: .env replaced existing ${KEY_NAME} entry."
    fi
  else
    printf "\n%s='%s'\n" "${KEY_NAME}" "${CHAT_ID}" >> "${mac_env}"
    log "Mac: .env appended ${KEY_NAME}."
  fi
else
  log "Mac: ${mac_env} not found; creating."
  mkdir -p "$(dirname "${mac_env}")"
  printf "%s='%s'\n" "${KEY_NAME}" "${CHAT_ID}" > "${mac_env}"
fi

if [[ -f "${mac_json}" ]]; then
  cp "${mac_json}" "${mac_json}.bak-pre-rescue-chat-id-${TS}"
  if command -v jq >/dev/null 2>&1; then
    current=$(jq -r --arg k "${KEY_NAME}" '.env.vars[$k] // empty' "${mac_json}" 2>/dev/null || true)
    if [[ "${current}" == "${CHAT_ID}" ]]; then
      log "Mac: openclaw.json env.vars already correct, skipping."
    else
      tmp="${mac_json}.tmp.$$"
      jq --arg k "${KEY_NAME}" --arg v "${CHAT_ID}" \
        '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[$k] = $v' \
        "${mac_json}" > "${tmp}" && mv "${tmp}" "${mac_json}"
      log "Mac: openclaw.json env.vars.${KEY_NAME} set."
    fi
  else
    log "Mac: WARN jq not installed; skipping openclaw.json patch. Install jq and rerun."
  fi
else
  log "Mac: WARN ${mac_json} not found; skipping json patch."
fi

# ---------- Each VPS ----------

failures=()

for entry in "${ROSTER[@]}"; do
  IFS='|' read -r client ip container compose_dir <<< "${entry}"
  log "VPS ${client} (${ip}): starting propagation."

  # Build the remote payload as a heredoc, executed in one ssh invocation.
  remote_script=$(cat <<REMOTE
set -u
set -o pipefail
TS="${TS}"
KEY="${KEY_NAME}"
VAL="${CHAT_ID}"
ENV_FILE_CONTAINER=/data/.openclaw/secrets/.env
JSON_FILE_CONTAINER=/data/.openclaw/openclaw.json
HOST_ENV_FILE="${compose_dir}/.env"
COMPOSE_DIR="${compose_dir}"
CONTAINER="${container}"

# 1. Update the HOST-level .env (where Hostinger Docker Manager UI writes; the
#    canonical place per the Hostinger env-file-location memory entry).
if [[ -f "\${HOST_ENV_FILE}" ]]; then
  cp "\${HOST_ENV_FILE}" "\${HOST_ENV_FILE}.bak-pre-rescue-chat-id-\${TS}"
  if grep -qE "^\${KEY}=" "\${HOST_ENV_FILE}"; then
    if grep -qE "^\${KEY}=['\"]?\${VAL}['\"]?\\\$" "\${HOST_ENV_FILE}"; then
      echo "  host .env: already correct, skipping."
      ALREADY_HOST=1
    else
      sed -i "s|^\${KEY}=.*\\\$|\${KEY}='\${VAL}'|" "\${HOST_ENV_FILE}"
      echo "  host .env: replaced existing entry."
      ALREADY_HOST=0
    fi
  else
    printf "\n%s='%s'\n" "\${KEY}" "\${VAL}" >> "\${HOST_ENV_FILE}"
    echo "  host .env: appended."
    ALREADY_HOST=0
  fi
else
  echo "  host .env: \${HOST_ENV_FILE} missing; creating."
  mkdir -p "\${COMPOSE_DIR}"
  printf "%s='%s'\n" "\${KEY}" "\${VAL}" > "\${HOST_ENV_FILE}"
  ALREADY_HOST=0
fi

# 2. Also update the inside-container .env so anything inside the container that
#    re-reads the file directly sees the same value.
if docker exec "\${CONTAINER}" test -f "\${ENV_FILE_CONTAINER}" 2>/dev/null; then
  docker exec "\${CONTAINER}" cp "\${ENV_FILE_CONTAINER}" "\${ENV_FILE_CONTAINER}.bak-pre-rescue-chat-id-\${TS}"
  if docker exec "\${CONTAINER}" grep -qE "^\${KEY}=" "\${ENV_FILE_CONTAINER}"; then
    if docker exec "\${CONTAINER}" grep -qE "^\${KEY}=['\"]?\${VAL}['\"]?\\\$" "\${ENV_FILE_CONTAINER}"; then
      echo "  container .env: already correct."
    else
      docker exec "\${CONTAINER}" sed -i "s|^\${KEY}=.*\\\$|\${KEY}='\${VAL}'|" "\${ENV_FILE_CONTAINER}"
      echo "  container .env: replaced."
    fi
  else
    docker exec "\${CONTAINER}" sh -c "printf '\n%s=\"%s\"\n' \"\${KEY}\" \"\${VAL}\" >> \${ENV_FILE_CONTAINER}"
    echo "  container .env: appended."
  fi
else
  echo "  container .env: \${ENV_FILE_CONTAINER} not present inside container, skipping."
fi

# 3. Patch openclaw.json env.vars inside the container so the gateway picks it
#    up at runtime even if env_file is not wired.
if docker exec "\${CONTAINER}" test -f "\${JSON_FILE_CONTAINER}" 2>/dev/null; then
  if docker exec "\${CONTAINER}" sh -c 'command -v jq >/dev/null 2>&1'; then
    current=\$(docker exec "\${CONTAINER}" jq -r --arg k "\${KEY}" '.env.vars[\$k] // empty' "\${JSON_FILE_CONTAINER}" 2>/dev/null || true)
    if [[ "\${current}" == "\${VAL}" ]]; then
      echo "  container openclaw.json: already correct."
      ALREADY_JSON=1
    else
      docker exec "\${CONTAINER}" cp "\${JSON_FILE_CONTAINER}" "\${JSON_FILE_CONTAINER}.bak-pre-rescue-chat-id-\${TS}"
      docker exec "\${CONTAINER}" sh -c "jq --arg k '\${KEY}' --arg v '\${VAL}' '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\\\$k] = \\\$v' \${JSON_FILE_CONTAINER} > \${JSON_FILE_CONTAINER}.tmp && mv \${JSON_FILE_CONTAINER}.tmp \${JSON_FILE_CONTAINER}"
      echo "  container openclaw.json: patched."
      ALREADY_JSON=0
    fi
  else
    echo "  container openclaw.json: WARN jq missing in container; skipping json patch."
    ALREADY_JSON=1
  fi
else
  echo "  container openclaw.json: not found; skipping."
  ALREADY_JSON=1
fi

# 4. If anything actually changed on the host .env, force-recreate. If only the
#    inside-container files changed (or nothing changed), skip recreate.
if [[ "\${ALREADY_HOST:-1}" == "0" ]]; then
  echo "  host .env changed; running docker compose up -d --force-recreate to reload env."
  cd "\${COMPOSE_DIR}"
  docker compose up -d --force-recreate 2>&1 | tail -10
else
  echo "  host .env unchanged; skipping force-recreate."
fi

echo "  done."
REMOTE
)

  if ssh "${SSH_OPTS[@]}" "root@${ip}" "bash -s" <<< "${remote_script}"; then
    log "VPS ${client}: OK"
  else
    log "VPS ${client}: FAILED"
    failures+=("${client}")
  fi
done

# ---------- Each Mac-tunnel client ----------

mac_ok=()
mac_failures=()

for entry in "${MAC_ROSTER[@]}"; do
  IFS='|' read -r client alias <<< "${entry}"
  log "MAC ${client} (${alias}): starting propagation."

  mac_remote=$(cat <<MACREMOTE
set -u
TS="${TS}"
KEY="${KEY_NAME}"
VAL="${CHAT_ID}"
HOME_DIR="\${HOME}"
ENV_FILE="\${HOME_DIR}/.openclaw/secrets/.env"
JSON_FILE="\${HOME_DIR}/.openclaw/openclaw.json"

if [ -f "\${ENV_FILE}" ]; then
  cp "\${ENV_FILE}" "\${ENV_FILE}.bak-pre-rescue-chat-id-\${TS}"
  if grep -qE "^\${KEY}=" "\${ENV_FILE}"; then
    if grep -qE "^\${KEY}=['\"]?\${VAL}['\"]?\$" "\${ENV_FILE}"; then
      echo "  .env: already correct"
    else
      sed -i '' "s|^\${KEY}=.*\$|\${KEY}='\${VAL}'|" "\${ENV_FILE}" 2>/dev/null \
        || sed -i "s|^\${KEY}=.*\$|\${KEY}='\${VAL}'|" "\${ENV_FILE}"
      echo "  .env: replaced"
    fi
  else
    printf "\n%s='%s'\n" "\${KEY}" "\${VAL}" >> "\${ENV_FILE}"
    echo "  .env: appended"
  fi
else
  mkdir -p "\$(dirname "\${ENV_FILE}")"
  printf "%s='%s'\n" "\${KEY}" "\${VAL}" > "\${ENV_FILE}"
  echo "  .env: created"
fi

if [ -f "\${JSON_FILE}" ]; then
  if command -v jq >/dev/null 2>&1; then
    cur=\$(jq -r --arg k "\${KEY}" '.env.vars[\$k] // empty' "\${JSON_FILE}" 2>/dev/null || true)
    if [ "\${cur}" = "\${VAL}" ]; then
      echo "  openclaw.json: already correct"
    else
      jq --arg k "\${KEY}" --arg v "\${VAL}" \
        '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\$k] = \$v' \
        "\${JSON_FILE}" > "\${JSON_FILE}.tmp.\$\$" && mv "\${JSON_FILE}.tmp.\$\$" "\${JSON_FILE}"
      echo "  openclaw.json: patched"
    fi
  else
    echo "  openclaw.json: jq missing; skipping"
  fi
else
  echo "  openclaw.json: not found; skipping"
fi
echo "[verify] KEY:"
grep -E "^\${KEY}=" "\${ENV_FILE}" 2>/dev/null || echo "  (not in .env)"
echo "[note] Mac gateway NOT restarted."
MACREMOTE
)

  if ssh "${MAC_SSH_OPTS[@]}" "${alias}" "zsh -lc 'bash -s'" <<< "${mac_remote}"; then
    log "MAC ${client}: OK"
    mac_ok+=("${client}")
  else
    log "MAC ${client}: FAILED (tunnel down? FileVault? service token?)"
    mac_failures+=("${client}")
  fi
done

# ---------- Summary ----------

echo
echo "==================================================="
echo "Propagation summary (UTC ${TS})"
echo "  chat_id: ${CHAT_ID}"
echo "  Mac (Trevor): ${mac_env}, ${mac_json}"
echo "  VPSes:   ${#ROSTER[@]} total"
echo "  Mac-tunnel: ${#MAC_ROSTER[@]} total"
if [[ ${#failures[@]} -eq 0 && ${#mac_failures[@]} -eq 0 ]]; then
  echo "  status:  ALL OK"
  echo "==================================================="
  exit 0
else
  [[ ${#failures[@]} -gt 0 ]] && echo "  vps-failed:  ${failures[*]}"
  [[ ${#mac_failures[@]} -gt 0 ]] && echo "  mac-failed:  ${mac_failures[*]}"
  echo "==================================================="
  exit 2
fi
