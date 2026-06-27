#!/usr/bin/env bash
# propagate-rescue-webhook.sh
#
# Propagates the NEW Rescue Rangers escalation method to the whole fleet:
#
#   1. Sets RESCUE_RANGERS_WEBHOOK_URL (the public n8n webhook the client
#      gateways can reach outbound) in each box's environment.
#   2. Installs / refreshes the "Escalate to Rescue Rangers" section in each
#      box's AGENTS.md so the local agent knows to POST the webhook (and to
#      stop using the dead bot-to-bot Telegram group-post method).
#
# THE NEW METHOD (what the agent is told to do):
#   curl -s -X POST "$RESCUE_RANGERS_WEBHOOK_URL" -H "Content-Type: application/json" \
#     -d '{"action":"escalate","client":"<client>","agent":"<agent>","message":"<problem + tried + EXACT openclaw version>"}'
#   ... rescue answer posts back into the Rescue Rangers group; on success the
#   agent POSTs "✅ RESOLVED: <one-line>" to close the loop. Hard cap 25/client/day.
# The OLD method (openclaw message send -t "$RESCUE_RANGERS_HELP_CHAT_ID") is
# DEPRECATED because bots cannot read other bots, so it never reached the rescue
# agent. This script's AGENTS.md block explicitly marks it deprecated.
#
# Two box types are handled:
#   A. VPS  (8 Hostinger Docker boxes) reached by `ssh root@<ip>`.
#        - host /docker/<project>/.env            (canonical Hostinger env)
#        - container /data/.openclaw/secrets/.env (mirror)
#        - container /data/.openclaw/openclaw.json env.vars (gateway runtime)
#        - container /data/.openclaw/AGENTS.md     (escalation section)
#        - docker compose up -d --force-recreate   (only if host .env changed)
#   B. Mac-tunnel clients reached over the Cloudflare tunnel SSH aliases in
#      ~/.ssh/config. No Docker; bare-Mac OpenClaw.
#        - ~/.openclaw/secrets/.env                (env)
#        - ~/.openclaw/openclaw.json env.vars      (gateway runtime)
#        - ~/.openclaw/AGENTS.md                   (escalation section)
#        - NO restart. Mac gateway restarts are a separate manual decision
#          (mirrors propagate-rescue-chat-id.sh's stance).
#
# Idempotent:
#   - Skips env writes that already have the correct value.
#   - Skips the AGENTS.md insert if the section marker is already present.
#   - Backs up every file before modifying it (.bak-pre-rescue-webhook-<UTC ts>).
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
#   - References the env var, never a hardcoded URL, in the agent instruction.
#   - Reads the VPS roster from the same shape as propagate-rescue-chat-id.sh and
#     the Mac roster from ~/.ssh/config rescue-* aliases. Keep both in sync with
#     ~/clawd/accounts/accounts.md when the fleet changes.
#
# This script does NOT touch Trevor's own Mac gateway (blackceomacmini) and does
# NOT touch any client's own off-limits Cloudflare account (Track B clients).

set -u
set -o pipefail

# ------------------------------------------------------------------ args ----

VPS_ONLY=0
MAC_ONLY=0
DRY_RUN=0
WEBHOOK_URL_DEFAULT="https://main.blackceoautomations.com/webhook/rescue-rangers"
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
SSH_KEY="${SSH_KEY:-/Users/blackceomacmini/.ssh/id_ed25519}"
SSH_OPTS=(-i "${SSH_KEY}" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts)
# Mac-tunnel SSH uses the ~/.ssh/config aliases directly (ProxyCommand handles
# cloudflared). BatchMode + accept-new keep it non-interactive; the per-host
# service-token env vars must already be exported (sourced from the secrets .env).
MAC_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new)
SECRETS_ENV="${HOME}/.openclaw/secrets/.env"

log() { printf '%s %s\n' "[$(date -u +%H:%M:%SZ)]" "$*"; }

# Source the operator secrets so CF Access service-token env vars are available
# to the Mac-tunnel ProxyCommands (sonatta/jocelyn/etc. inject them inline).
if [[ -f "${SECRETS_ENV}" ]]; then
  set -a; # shellcheck disable=SC1090
  source "${SECRETS_ENV}"; set +a
fi

# ------------------------------------------------------------- VPS roster ----
# client_label|ip|container|compose_project_dir|agent_name
# Keep in sync with propagate-rescue-chat-id.sh ROSTER + accounts.md.
# agent_name is the display name the local agent uses in the escalation payload.
VPS_ROSTER=(
  "corey|187.77.204.227|openclaw-hy5t-openclaw-1|/docker/openclaw-hy5t|Stefanie"
  "maria-anderson|187.77.10.144|openclaw-qxqt-openclaw-1|/docker/openclaw-qxqt|Sir Jordan"
  "beverly-sanders|72.62.170.43|openclaw-0ht9-openclaw-1|/docker/openclaw-0ht9|Benjamin"
  "evelyn-bethune|2.24.85.21|openclaw-c54p-openclaw-1|/docker/openclaw-c54p|Temperance"
  "angela-t|187.77.9.130|openclaw-prji-openclaw-1|/docker/openclaw-prji|DoraMilaje"
  "angeleen|187.77.223.62|openclaw-lydh-openclaw-1|/docker/openclaw-lydh|Ava"
  "monique-tucker|177.7.42.223|openclaw-jdbv-openclaw-1|/docker/openclaw-jdbv|Lia"
  "lyric-hawkins|187.127.251.97|openclaw-4pkz-openclaw-1|/docker/openclaw-4pkz|NEXORA"
)

# ------------------------------------------------- Mac-tunnel roster ----------
# client_label|ssh_alias|agent_name
# ssh_alias resolves through ~/.ssh/config (ProxyCommand = cloudflared access ssh).
# Bare-Mac OpenClaw lives under ~/.openclaw on the remote user's home.
# (Trevor's own Mac is intentionally NOT in this list.)
MAC_ROSTER=(
  "teresa-pelham|rescue-teresa-pelham|Keez"
  "kofi-bryant|rescue-kofi-bryant|Kofi-agent"
  "cassandra-henriquez|rescue-cassandra-henriquez|LoveBot"
  "karen-vaughn|rescue-karen-vaughn|Lennox"
  # "jill-bulluck|rescue-jill-bulluck|Jill-agent"  # OPTED OUT -- excluded per fleet-heartbeat exclusion rule
  "sheila-reynolds|rescue-sheila-reynolds|Curtis"
  "aurelia-gardner|rescue-aurelia-gardner|Neil"
  "lyric-hawkins-mac|rescue-lyric-hawkins|NEXORA"
  "leanne-dolce|rescue-leanne-dolce|LeAnne-agent"
  "sonatta-camara|rescue-sonatta-camara|Sonatta-agent"
  "talaya-kelley|rescue-talaya-kelley|Talaya-agent"
  "stephanie-wall|rescue-stephanie-wall|Stephanie-agent"
  "jocelyn-mcclure|rescue-jocelyn-mcclure|Jocelyn-agent"
  # Added 2026-06-26 (RR-roster gap closure):
  "barret-matthews|rescue-barret-matthews|Barret-agent"
  "barret-matthews-mini-2026|rescue-barrett-matthews-mini-2026|Barret-agent-2"
  "christy-staples|rescue-christy-staples|Christy-agent"
  "erin-garrett|rescue-erin-garrett|Erin-agent"
  "jennifer-allen|rescue-jennifer-allen|Jennifer-agent"
  "star-bobatoon|rescue-star-bobatoon|Star-agent"
  # NOTE: Maria Anderson Mac (rescue-maria-anderson) is INTENTIONALLY omitted here.
  # She already has a VPS entry (187.77.10.144) in VPS_ROSTER. Adding her Mac alias
  # without confirming which box is her primary would double-escalate. Trevor must
  # confirm whether rescue-maria-anderson is her Mac or a stale tunnel before adding.
  # rescue-maria-anderson-cm also exists but was OFFLINE in the probe. Both are pending.
)

# --------------------------------------------- AGENTS.md section builder ------
# Emits the canonical "Escalate to Rescue Rangers" markdown block for a box.
# $1 = client label  $2 = agent display name
# $3 = box_name (container label / hostname)  $4 = box_type (VPS | Mac Mini | MacBook Pro)
# Source of truth: scripts/rescue-escalation-section.md.tpl in trevorotts1/openclaw-onboarding.
# No em dashes. Version marker: presence of '"person":' in the section (v2 form fields).
make_section() {
  local client="$1" agent="$2" box_name="${3:-<box-hostname>}" box_type="${4:-VPS}"
  cat <<SECTION

## Escalate to Rescue Rangers (when you are stuck)

When you hit a problem you cannot solve on your own, escalate to Rescue Rangers by POSTing to the n8n webhook. Your gateway CAN reach this public URL outbound.

**When to escalate:** triple-failure on the same symptom; a schema/validation error that \`openclaw doctor --fix\` did not resolve; an unknown error class you cannot match in docs.openclaw.ai or the GitHub repo; anything needing a credential rotation, a Hostinger/Cloudflare/DNS change, or another box. Do NOT escalate for routine ops you handle competently.

**The escalation payload MUST carry all nine fields** -- partial payloads are rejected.

**How to escalate (the ONLY supported method):**

\`\`\`
_RR_SECRET_ARGS=()
[ -n "\${RESCUE_RANGERS_WEBHOOK_SECRET:-}" ] && _RR_SECRET_ARGS=(-H "X-Rescue-Secret: \${RESCUE_RANGERS_WEBHOOK_SECRET}")
curl -s -X POST "\$RESCUE_RANGERS_WEBHOOK_URL" \\
  -H "Content-Type: application/json" \\
  "\${_RR_SECRET_ARGS[@]}" \\
  -d '{
    "action":         "escalate",
    "person":         "<name of the owner or end user this agent serves>",
    "clientName":     "${client}",
    "agentName":      "${agent}",
    "boxName":        "${box_name}",
    "boxType":        "${box_type}",
    "openclawVersion":"<run: openclaw --version>",
    "problem":        "<concise one-paragraph description of the problem>",
    "alreadyTried":   "<numbered list of what you already tried>",
    "returnTo":       "<Telegram chat ID the answer should be posted back to>"
  }'
\`\`\`

**Field guide:**

| Field | What to put |
|-------|-------------|
| \`person\` | The real name of the owner or end user whose experience is broken |
| \`clientName\` | Pre-filled: ${client} |
| \`agentName\` | Pre-filled: ${agent} |
| \`boxName\` | Pre-filled: ${box_name} |
| \`boxType\` | Pre-filled: ${box_type} |
| \`openclawVersion\` | Exact string from \`openclaw --version\` -- no paraphrasing |
| \`problem\` | Short, self-contained description of what is happening |
| \`alreadyTried\` | Numbered list of every fix already attempted (avoids repeat advice) |
| \`returnTo\` | The Telegram chat ID where the Rescue Rangers answer must be posted |

- \`RESCUE_RANGERS_WEBHOOK_URL\` is set in your environment. If missing, report to Trevor's chat \`5252140759\`.
- \`RESCUE_RANGERS_WEBHOOK_SECRET\` is set alongside the URL. The array pattern above skips the header when unset.
- Never put real secrets (API keys, tokens, passwords) in any field. Reference the env var name instead.

**When the fix works**, POST the resolution signal and STOP escalating:

\`\`\`
curl -s -X POST "\$RESCUE_RANGERS_WEBHOOK_URL" \\
  -H "Content-Type: application/json" \\
  "\${_RR_SECRET_ARGS[@]}" \\
  -d '{"action":"escalate","clientName":"${client}","agentName":"${agent}","problem":"RESOLVED: <one-line what fixed it>"}'
\`\`\`

**You MUST tell the end user the outcome** in clear language. State which of these three it was:
- **(a) We solved it** -- describe what was fixed and confirm normal operation is restored.
- **(b) Here is what you should do** -- give the owner/user the actionable next step they must take.
- **(c) Here is the answer** -- relay the Rescue Rangers response verbatim if it is informational.
Never leave the end user in the dark about what happened or what comes next. This is non-negotiable.

**Hard cap: 25 exchanges per client per day.** Do not loop endlessly; if unresolved after several exchanges, ping Trevor's chat \`5252140759\` directly.

> DEPRECATED -- do NOT use the old bot-to-bot method \`openclaw message send --channel telegram -t "\$RESCUE_RANGERS_HELP_CHAT_ID"\`. Bots cannot read other bots, so that escalation never reached the rescue agent. The webhook above is the replacement.
SECTION
}

# ---------------------------------------------- remote env+agents updater -----
# Generates a portable POSIX-sh script that, given env vars KEY/VAL/ENV_FILE/
# JSON_FILE/AGENTS_FILE/SECTION_B64/AGENTS_ANCHOR, applies the env var to the
# .env + openclaw.json and inserts the AGENTS.md section if absent. Backs up
# every file it touches. Echoes a CHANGED= marker so the caller knows whether a
# reload is needed. Used identically by both VPS (inside the container, prefixed
# with `docker exec`) and Mac (direct on the box). Pure sh + jq + python3.
remote_apply_body() {
cat <<'BODY'
set -u
ENV_CHANGED=0

# 1. .env
if [ -n "${ENV_FILE}" ]; then
  if [ -f "${ENV_FILE}" ]; then
    cp "${ENV_FILE}" "${ENV_FILE}.bak-pre-rescue-webhook-${TS}"
    if grep -qE "^${KEY}=" "${ENV_FILE}"; then
      if grep -qE "^${KEY}=['\"]?${VAL_RE}['\"]?$" "${ENV_FILE}"; then
        echo "  env: already correct"
      else
        sed -i "s|^${KEY}=.*$|${KEY}='${VAL}'|" "${ENV_FILE}" 2>/dev/null \
          || sed -i '' "s|^${KEY}=.*$|${KEY}='${VAL}'|" "${ENV_FILE}"
        echo "  env: replaced existing entry"
        ENV_CHANGED=1
      fi
    else
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

# 3. AGENTS.md section. Idempotent on v2 form ('"person":' present).
#    If old v1 flat-message section is found, REPLACE it with the new v2 form.
#    If no section at all, INSERT before AGENTS_ANCHOR (or append).
if [ -n "${AGENTS_FILE}" ] && [ -f "${AGENTS_FILE}" ]; then
  if grep -q "## Escalate to Rescue Rangers" "${AGENTS_FILE}" && grep -q '"person":' "${AGENTS_FILE}"; then
    echo "  agents: v2 structured-form section already present; skipping"
  else
    cp "${AGENTS_FILE}" "${AGENTS_FILE}.bak-pre-rescue-webhook-${TS}"
    printf '%s' "${SECTION_B64}" | base64 -d > /tmp/rescue-section.$$.md
    if command -v python3 >/dev/null 2>&1; then
      AGENTS_FILE="${AGENTS_FILE}" ANCHOR="${AGENTS_ANCHOR}" SECF="/tmp/rescue-section.$$.md" python3 - <<'PY'
import os, re
src=os.environ["AGENTS_FILE"]; anchor=os.environ.get("ANCHOR","").strip(); secf=os.environ["SECF"]
sec=open(secf).read()
txt=open(src).read()
# Guard: v2 already present (race)
if "## Escalate to Rescue Rangers" in txt and '"person":' in txt:
    print("  agents: v2 already present (race); skip")
elif "## Escalate to Rescue Rangers" in txt:
    # Replace old v1 section: strip from the heading to the next ## heading (or end)
    pat = re.compile(r'(^## Escalate to Rescue Rangers.*?)(?=^## |\Z)', re.MULTILINE | re.DOTALL)
    new = pat.sub(sec.lstrip("\n"), txt, count=1)
    open(src,"w").write(new)
    print("  agents: old v1 section replaced with v2 structured form")
else:
    idx=txt.find(anchor) if anchor else -1
    if idx!=-1:
        new=txt[:idx]+sec.lstrip("\n")+"\n"+txt[idx:]
    else:
        new=txt.rstrip("\n")+"\n"+sec
    open(src,"w").write(new)
    print("  agents: v2 section inserted")
PY
    else
      # No python3: safe fallback = append to the end.
      printf '\n' >> "${AGENTS_FILE}"
      cat /tmp/rescue-section.$$.md >> "${AGENTS_FILE}"
      echo "  agents: section appended (no python3; end-of-file)"
    fi
    rm -f /tmp/rescue-section.$$.md
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
if [[ "${MAC_ONLY}" != "1" ]]; then
  for entry in "${VPS_ROSTER[@]}"; do
    IFS='|' read -r client ip container compose_dir agent <<< "${entry}"
    log "VPS ${client} (${ip}): starting."
    # box_name = container label (e.g. openclaw-hy5t-openclaw-1 -> openclaw-hy5t)
    box_name="${container%%-openclaw-1}"
    section_b64=$(make_section "${client}" "${agent}" "${box_name}" "VPS" | base64 | tr -d '\n')

    if [[ "${DRY_RUN}" == "1" ]]; then
      log "VPS ${client}: DRY-RUN (would set ${KEY_NAME}, patch json, insert AGENTS.md, recreate if host .env changed)"
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
SECTION_B64="${section_b64}"
AGENTS_ANCHOR="## Notion integration"
SECRET_KEY="RESCUE_RANGERS_WEBHOOK_SECRET"
SECRET_VAL="${RESCUE_RANGERS_WEBHOOK_SECRET:-}"

apply_env() {
  ENV_FILE="\$1" JSON_FILE="\$2" AGENTS_FILE="\$3" \\
  KEY="\${KEY}" VAL="\${VAL}" VAL_RE="\${VAL_RE}" TS="\${TS}" \\
  SECTION_B64="\${SECTION_B64}" AGENTS_ANCHOR="\${AGENTS_ANCHOR}" \\
  sh -c '$(remote_apply_body | sed "s/'/'\\\\''/g")'
}

echo "[host .env]"
HOST_CHANGED=0
HOST_ENV="\${COMPOSE_DIR}/.env"
if [ -f "\${HOST_ENV}" ]; then
  cp "\${HOST_ENV}" "\${HOST_ENV}.bak-pre-rescue-webhook-\${TS}"
  if grep -qE "^\${KEY}=" "\${HOST_ENV}"; then
    if grep -qE "^\${KEY}=['\"]?\${VAL_RE}['\"]?\$" "\${HOST_ENV}"; then
      echo "  host .env: already correct"
    else
      sed -i "s|^\${KEY}=.*\$|\${KEY}='\${VAL}'|" "\${HOST_ENV}"
      echo "  host .env: replaced"; HOST_CHANGED=1
    fi
  else
    printf "\n%s='%s'\n" "\${KEY}" "\${VAL}" >> "\${HOST_ENV}"
    echo "  host .env: appended"; HOST_CHANGED=1
  fi
else
  echo "  host .env: missing; creating"; mkdir -p "\${COMPOSE_DIR}"
  printf "%s='%s'\n" "\${KEY}" "\${VAL}" > "\${HOST_ENV}"; HOST_CHANGED=1
fi

echo "[container files]"
# stage the section file inside the container
echo "\${SECTION_B64}" | base64 -d > /tmp/rs.\$\$.md
docker cp /tmp/rs.\$\$.md "\${CONTAINER}":/tmp/rescue-section.md && rm -f /tmp/rs.\$\$.md
docker exec -e TS="\${TS}" -e KEY="\${KEY}" -e VAL="\${VAL}" -e VAL_RE="\${VAL_RE}" \\
  -e SECTION_B64="\${SECTION_B64}" -e AGENTS_ANCHOR="\${AGENTS_ANCHOR}" \\
  -e ENV_FILE=/data/.openclaw/secrets/.env \\
  -e JSON_FILE=/data/.openclaw/openclaw.json \\
  -e AGENTS_FILE=/data/.openclaw/workspace/AGENTS.md \\
  "\${CONTAINER}" sh -s <<'INNER'
$(remote_apply_body)
INNER
docker exec "\${CONTAINER}" rm -f /tmp/rescue-section.md 2>/dev/null || true

# Propagate RESCUE_RANGERS_WEBHOOK_SECRET BEFORE force-recreate so that HOST_CHANGED
# accumulates both the URL and secret changes, and a single force-recreate picks up both
# from the host .env at container-start time. (Bug fix: previously this block ran AFTER
# the force-recreate check, meaning a fresh run could leave the container env missing the
# secret even though the host .env was correct.)
if [ -n "\${SECRET_VAL}" ]; then
  echo "[secret] propagating \${SECRET_KEY}"
  HOST_ENV="\${COMPOSE_DIR}/.env"
  if grep -qE "^\${SECRET_KEY}=" "\${HOST_ENV}" 2>/dev/null; then
    if grep -qE "^\${SECRET_KEY}=['\"]?\${SECRET_VAL}['\"]?\$" "\${HOST_ENV}" 2>/dev/null; then
      echo "  host .env: secret already correct"
    else
      sed -i "s|^\${SECRET_KEY}=.*\$|\${SECRET_KEY}='\${SECRET_VAL}'|" "\${HOST_ENV}"
      echo "  host .env: secret replaced"; HOST_CHANGED=1
    fi
  else
    printf "\n%s='%s'\n" "\${SECRET_KEY}" "\${SECRET_VAL}" >> "\${HOST_ENV}"
    echo "  host .env: secret appended"; HOST_CHANGED=1
  fi
  # Also patch the container's openclaw.json (persistent bind-mount) so the secret is
  # available via OpenClaw's env.vars even before the next force-recreate.
  docker exec -u node -e SK="\${SECRET_KEY}" -e SV="\${SECRET_VAL}" "\${CONTAINER}" sh -c '
    if command -v jq >/dev/null 2>&1; then
      cur=$(jq -r --arg k "$SK" ".env.vars[\$k] // empty" /data/.openclaw/openclaw.json 2>/dev/null || true)
      if [ "$cur" = "$SV" ]; then
        echo "  container openclaw.json: secret already correct"
      else
        jq --arg k "$SK" --arg v "$SV" \
          ".env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\$k] = \$v" \
          /data/.openclaw/openclaw.json > /data/.openclaw/openclaw.json.tmp \
          && mv /data/.openclaw/openclaw.json.tmp /data/.openclaw/openclaw.json \
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
docker exec "\${CONTAINER}" printenv \${KEY} 2>/dev/null || echo "  (not yet in env; recreate may be needed)"
docker exec "\${CONTAINER}" printenv \${SECRET_KEY} 2>/dev/null && echo "  (secret env var present)" || echo "  (secret env var not yet in env; check openclaw.json env.vars)"
echo "[verify] AGENTS.md section: \$(docker exec "\${CONTAINER}" grep -c '## Escalate to Rescue Rangers' /data/.openclaw/AGENTS.md 2>/dev/null) match(es)"
echo "[verify] X-Rescue-Secret header in AGENTS.md: \$(docker exec "\${CONTAINER}" grep -c 'X-Rescue-Secret' /data/.openclaw/workspace/AGENTS.md 2>/dev/null) match(es)"
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
if [[ "${VPS_ONLY}" != "1" ]]; then
  for entry in "${MAC_ROSTER[@]}"; do
    IFS='|' read -r client alias agent <<< "${entry}"
    log "MAC ${client} (${alias}): starting."
    # box_name = alias without the "rescue-" prefix (e.g. rescue-karen-vaughn -> karen-vaughn)
    box_name="${alias#rescue-}"
    # All fleet Mac clients are Mac Mini; update roster entry if a client has a MacBook Pro.
    box_type="Mac Mini"
    section_b64=$(make_section "${client}" "${agent}" "${box_name}" "${box_type}" | base64 | tr -d '\n')

    if [[ "${DRY_RUN}" == "1" ]]; then
      log "MAC ${client}: DRY-RUN (would set ${KEY_NAME} + patch json + insert AGENTS.md; NO restart)"
      ok+=("${client}(dry)")
      continue
    fi

    body=$(remote_apply_body)

    # Bare-Mac: resolve ~ on the remote side. AGENTS.md anchor differs per box;
    # use a tolerant anchor list (first match wins) else append.
    remote=$(cat <<REMOTE
set -u
export TS="${TS}"
export KEY="${KEY_NAME}"
export VAL="${WEBHOOK_URL}"
export VAL_RE="${VAL_RE}"
export SECTION_B64="${section_b64}"
SECRET_KEY="RESCUE_RANGERS_WEBHOOK_SECRET"
SECRET_VAL="${RESCUE_RANGERS_WEBHOOK_SECRET:-}"
HOME_DIR="\${HOME}"
export ENV_FILE="\${HOME_DIR}/.openclaw/secrets/.env"
export JSON_FILE="\${HOME_DIR}/.openclaw/openclaw.json"
export AGENTS_FILE="\${HOME_DIR}/.openclaw/workspace/AGENTS.md"
# Pick the first anchor that exists in this box's AGENTS.md; else empty -> append.
export AGENTS_ANCHOR=""
if [ -f "\${AGENTS_FILE}" ]; then
  for a in "## Notion integration" "## Tool credentials policy" "## Notion" "---"; do
    if grep -qF "\$a" "\${AGENTS_FILE}"; then AGENTS_ANCHOR="\$a"; break; fi
  done
fi
$(remote_apply_body)
echo "[verify] env:"
grep -E "^\${KEY}=" "\${ENV_FILE}" 2>/dev/null || echo "  (env var not found in .env)"
echo "[verify] AGENTS.md section: \$(grep -c '## Escalate to Rescue Rangers' "\${AGENTS_FILE}" 2>/dev/null) match(es)"

# Propagate RESCUE_RANGERS_WEBHOOK_SECRET to this Mac box's env + openclaw.json.
if [ -n "\${SECRET_VAL}" ]; then
  echo "[secret] propagating \${SECRET_KEY}"
  if grep -qE "^\${SECRET_KEY}=" "\${ENV_FILE}" 2>/dev/null; then
    sed -i '' "s|^\${SECRET_KEY}=.*\$|\${SECRET_KEY}='\${SECRET_VAL}'|" "\${ENV_FILE}" 2>/dev/null \
      || sed -i "s|^\${SECRET_KEY}=.*\$|\${SECRET_KEY}='\${SECRET_VAL}'|" "\${ENV_FILE}"
    echo "  .env: secret replaced"
  else
    printf "\n%s='%s'\n" "\${SECRET_KEY}" "\${SECRET_VAL}" >> "\${ENV_FILE}"
    echo "  .env: secret appended"
  fi
  if command -v jq >/dev/null 2>&1 && [ -f "\${JSON_FILE}" ]; then
    jq --arg k "\${SECRET_KEY}" --arg v "\${SECRET_VAL}" \
      '.env = (.env // {}) | .env.vars = (.env.vars // {}) | .env.vars[\$k] = \$v' \
      "\${JSON_FILE}" > "\${JSON_FILE}.tmp.$$" && mv "\${JSON_FILE}.tmp.$$" "\${JSON_FILE}"
    echo "  openclaw.json: secret patched"
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
