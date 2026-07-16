#!/usr/bin/env bash
# Fleet probe: SSH each VPS, capture OpenClaw version + gateway health.
# Output is one line per client, pipe-delimited so a sub-agent can parse it
# without ambiguity. Probes run in parallel (background jobs) so total wall
# time stays under 15s for the whole fleet.
#
# Output schema (one line per client):
#   <client>|<persona>|<ip>|<container>|<version>|<gateway>|<ssh>|<notes>
#
# Fields:
#   client     : human label (Corey, Maria Anderson, etc.)
#   persona    : agent name (Candace, Sir Jordan, etc.)
#   ip         : VPS public IP
#   container  : docker container name
#   version    : openclaw --version string OR "unknown"
#   gateway    : OK | DOWN | UNKNOWN  (gateway health on :18789/health)
#   ssh        : OK | DOWN            (SSH reachability)
#   notes      : free-form, e.g. timeout reason, container exit, etc.
#
# Exit code: 0 always (a probe failure is data, not a script error).

set -u

SSH_KEY="${SSH_KEY:-/Users/blackceomacmini/.ssh/id_ed25519}"
SSH_OPTS="-i ${SSH_KEY} -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-20}"

# Mac-tunnel clients (e.g. Teresa Pelham) are reached over a Cloudflare tunnel
# + Access service token, not root@IP. Pull ONLY the CF service-token vars from
# the canonical secrets file. We deliberately do NOT `source` the whole file:
# it contains unquoted values (spaces) and a PATH= override that would clobber
# this script's environment. Instead grep the three keys we need. Failures here
# are non-fatal: a mac-tunnel probe with missing creds simply reports DOWN.
SECRETS_ENV="${SECRETS_ENV:-/Users/blackceomacmini/.openclaw/secrets/.env}"
_read_env_var() {
  # _read_env_var KEY FILE -> prints the value with surrounding quotes stripped.
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n1)
  [ -z "$line" ] && return 0
  line="${line#*${key}=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}
CF_ACCESS_TERESA_SVC_CLIENT_ID="${CF_ACCESS_TERESA_SVC_CLIENT_ID:-$(_read_env_var CF_ACCESS_TERESA_SVC_CLIENT_ID "$SECRETS_ENV")}"
CF_ACCESS_TERESA_SVC_CLIENT_SECRET="${CF_ACCESS_TERESA_SVC_CLIENT_SECRET:-$(_read_env_var CF_ACCESS_TERESA_SVC_CLIENT_SECRET "$SECRETS_ENV")}"
export PATH="/opt/homebrew/bin:$PATH"
# Per-host hard wall-clock cap for mac-tunnel probes. Each attempt gets this many
# seconds; with 2 retries a worst-case hanging probe burns 2×timeout + 3s sleep.
# Kofi's tunnel fails instantly (bad handshake, rc255) so his cost is trivial.
# Sonatta's tunnel TCP-connects but SSH banner hangs until timeout fires.
# At 45s: worst-case = 45+3+45 = 93s per DOWN client (parallel, so wall ≈ 93s for 2 DOWN).
# At legacy 150s: worst-case = 150+3+150 = 303s per DOWN client → probe alone = 183s wall,
# leaving almost nothing of the 300s cron budget for remediation + re-probe.
CF_TUNNEL_TIMEOUT="${CF_TUNNEL_TIMEOUT:-45}"

# Mac base install has no timeout(1). Pick whatever wall-clock limiter is
# available; fall back to a small perl wrapper script which is always present
# on macOS. (We write the wrapper out as a sibling script and exec it via
# perl, avoiding any inline -e shell-quoting hazards.)
_TIMEOUT_WRAPPER="/Users/blackceomacmini/clawd/fleet-heartbeat/scripts/_timeout.pl"
if command -v timeout >/dev/null 2>&1; then
  _TIMEOUT() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  _TIMEOUT() { gtimeout "$@"; }
else
  _TIMEOUT() { perl "$_TIMEOUT_WRAPPER" "$@"; }
fi

# Roster pulled from ~/clawd/accounts/accounts.md.
# Format: client|persona|ip|container[|type]
#   type is optional and defaults to "vps" (root@IP + docker exec probe).
#   "mac-tunnel" clients are probed over a Cloudflare tunnel + Access service
#   token (no root@IP, no Docker container). For mac-tunnel rows the "ip" field
#   holds the SSH user and the "container" field holds the tunnel hostname.
ROSTER=(
  "Corey|Candace|187.77.204.227|openclaw-hy5t-openclaw-1"
  "Maria Anderson|Sir Jordan|187.77.10.144|openclaw-qxqt-openclaw-1"
  "Beverly Sanders|Benjamin|72.62.170.43|openclaw-0ht9-openclaw-1"
  "Evelyn Bethune|Temperance|2.24.85.21|openclaw-c54p-openclaw-1"
  "Angela T|DoraMilaje|187.77.9.130|openclaw-prji-openclaw-1"
  "Angeleen|Ava|187.77.223.62|openclaw-lydh-openclaw-1"
  "Monique Tucker|Lia|177.7.42.223|openclaw-jdbv-openclaw-1"
  "Lyric Hawkins|Nexora|187.127.251.97|openclaw-4pkz-openclaw-1"
  "Dr. Tola|TBD|2.25.167.145|openclaw-h7rp-openclaw-1"
  "Teresa Pelham|(no bot yet)|teresapelham|rescue-teresa-pelham.zerohumanworkforce.com|mac-tunnel"
  "Kofi Bryant|(no bot — full mgmt)|kofiesr.|rescue-kofi-bryant.zerohumanworkforce.com|mac-tunnel"
  "Cassandra Henriquez|LoveBot|coachcass|rescue-cassandra-henriquez.zerohumanworkforce.com|mac-tunnel"
  "Karen Vaughn|Lennox / @SirLennoxbot|karenvaughn|rescue-karen-vaughn.zerohumanworkforce.com|mac-tunnel"
  "Jill Bulluck|@melissa_jills_bot|jillbulluck|rescue-jill-bulluck.zerohumanworkforce.com|mac-tunnel"
  "Sheila Reynolds|Curtis|sheilareynolds|rescue-sheila-reynolds.zerohumanworkforce.com|mac-tunnel"
  "Aurelia Gardner|Neil|wib-wmg|rescue-aurelia-gardner.zerohumanworkforce.com|mac-tunnel"
  "Aurelia Gardner MBP|AURELIA_MACBOOKPRO|aureliagardner|rescue-aurelia-gardner-macbookpro.zerohumanworkforce.com|mac-tunnel"
  "Lyric Hawkins (Mac)|Nexora|rockstar360|rescue-lyric-hawkins.zerohumanworkforce.com|mac-tunnel"
  "LeAnne Dolce|Sade|wakeuphappysis|rescue-leanne-dolce.zerohumanworkforce.com|mac-tunnel"
  "Sonatta Camara|*(no bot)*|sonattamacmini|rescue-sonatta-camara.zerohumanworkforce.com|mac-tunnel"
  "Talaya Kelley|*(no bot)*|layakelley|rescue-talaya-kelley.zerohumanworkforce.com|mac-tunnel"
  "Stephanie Wall|*(no bot)*|stephaniewall|rescue-stephanie-wall.zerohumanworkforce.com|mac-tunnel"
  "Jocelyn McClure|*(no bot)*|jmcmac|rescue-jocelyn-mcclure.zerohumanworkforce.com|mac-tunnel"
  "Barret Matthews|*(no bot)*|administrator|rescue-barret-matthews.zerohumanworkforce.com|mac-tunnel"
  "Maria Anderson (Mac)|*(no bot)*|consulting|rescue-maria-anderson.zerohumanworkforce.com|mac-tunnel"
  "Christy Staples|*(no bot)*|clsemployee|rescue-christy-staples.zerohumanworkforce.com|mac-tunnel"
  "Erin Garrett|*(no bot)*|eg|rescue-erin-garrett.zerohumanworkforce.com|mac-tunnel"
  "Star Bobatoon|*(no bot)*|starbobatoon|rescue-star-bobatoon.zerohumanworkforce.com|mac-tunnel"
  "Barret Matthews (Mac Mini 2026)|*(no bot)*|barret|rescue-barrett-matthews-mini-2026.zerohumanworkforce.com|mac-tunnel"
  "Jennifer Allen|*(no bot)*|jennjack|rescue-jennifer-allen.zerohumanworkforce.com|mac-tunnel"
  "E.R. Spaulding|*(no bot)*|erspaulding|rescue-er-spaulding.zerohumanworkforce.com|mac-tunnel"
  "Eddie Otts|*(no bot)*|eddoeotts|rescue-eddie-otts.zerohumanworkforce.com|mac-tunnel"
  # --- Separate-account / other-provider boxes (added 2026-06-29 per fleet-coverage-gate) ---
  # Dr. Stephanie Brown — HER OWN Hostinger account (NOT Trevor's). Standard root@IP + docker probe.
  "Dr. Stephanie Brown|*(own Hostinger)*|2.25.210.81|openclaw-a3go-openclaw-1"
  # Contabo (provider 'contabo'): one shared host (ssh contabo-host), one container per client.
  # ip+container columns both carry the container name; probed via docker exec -u node. These run a
  # PINNED image on the client's OWN funded keys, so the auto-update step deliberately skips them.
  "Beverly Grandison|*(Premier H&W — Contabo)*|oc-beverly-grandison|oc-beverly-grandison|contabo"
  "Trevor Staff Clawspace|*(Contabo)*|oc-trevor|oc-trevor|contabo"
)

# Optional override: SIMULATE_DOWN=Corey,Beverly forces those rows to DOWN
# without actually touching the VPS. Used for smoke testing.
SIMULATE_DOWN="${SIMULATE_DOWN:-}"

# --mode smoke-test     equivalent to HEARTBEAT_MODE=smoke-test, also forces
#                       SIMULATE_DOWN if caller did not set it (default: Beverly).
# --simulate-down LIST  comma-separated client names to simulate as DOWN.
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      shift
      if [ "${1:-}" = "smoke-test" ]; then
        HEARTBEAT_MODE="smoke-test"
        [ -z "$SIMULATE_DOWN" ] && SIMULATE_DOWN="Beverly Sanders"
      fi
      shift || true
      ;;
    --simulate-down)
      shift
      SIMULATE_DOWN="${1:-}"
      shift || true
      ;;
    *)
      shift
      ;;
  esac
done

# In smoke-test mode without an explicit SIMULATE_DOWN, default to a marker
# row so the orchestrator has something to remediate against.
if [ "${HEARTBEAT_MODE:-}" = "smoke-test" ] && [ -z "$SIMULATE_DOWN" ]; then
  SIMULATE_DOWN="Beverly Sanders"
fi

# Probe a Mac client reached over a Cloudflare tunnel + Access service token.
# Args: client persona sshuser tunnelhost
# Emits the same 8-field schema as the VPS probe. The "ip" column carries the
# SSH user and the "container" column carries the tunnel hostname so the output
# stays self-describing. Any failure in the access chain -> DOWN, never a crash.
probe_mac_tunnel() {
  local client="$1" persona="$2" sshuser="$3" tunnelhost="$4"

  # Per-client Access service token: each mac-tunnel client (Teresa/Kofi/Cassandra)
  # has its OWN CF Access app + service token. Pick the right vars by client name.
  # Without them the tunnel cannot authenticate -> DOWN.
  local _tk cid csec
  case "$client" in
    *Cassandra*) _tk=CASSANDRA ;;
    *Kofi*)      _tk=KOFI ;;
    *Teresa*)    _tk=TERESA ;;
    *Karen*)     _tk=KAREN ;;
    *Jill*)      _tk=JILL ;;
    *Sheila*)    _tk=SHEILA ;;
    *Aurelia*)   _tk=AURELIA ;;
    *LeAnne*)   _tk=LEANNE_DOLCE ;;
    *Sonatta*)  _tk=SONATTA_CAMARA ;;
    *Talaya*)   _tk=TALAYA ;;
    *Stephanie*) _tk=STEPHANIE ;;
    *Jocelyn*)   _tk=JOCELYN ;;
    *"Barret Matthews (Mac Mini"*)    _tk=BARRETT_MINI ;;
    *Barret*)    _tk=BARRET ;;
    *"Jennifer Allen"*)    _tk=JENNIFER ;;
    *"E.R. Spaulding"*)    _tk=ER_SPAULDING ;;
    *Eddie*)     _tk=EDDIE_OTTS ;;
    *Maria*)     _tk=MARIA ;;
    *Christy*)   _tk=CHRISTY ;;
    *Erin*)      _tk=ERIN ;;
    *Lyric*)     _tk=LYRIC_HAWKINS ;;
    *Star*)      _tk=STAR ;;
    # No match: FAIL LOUDLY as a configuration error. A silent fall-through to
    # another client's token previously mis-probed Eddie Otts with Teresa
    # Pelham's credential and reported him UNREACHABLE — he was fine, the
    # token was wrong. A wrong-token probe must never be indistinguishable
    # from a real DOWN box. Any client landing here is missing a case in this
    # switch (an onboarding gap), not evidence the box is dead.
    *)           _tk="" ;;
  esac
  if [ -z "$_tk" ]; then
    echo "${client}|${persona}|${sshuser}|${tunnelhost}|unknown|UNKNOWN|DOWN|cf_token_unmapped_add_case_to_probe_mac_tunnel_in_probe-fleet.sh"
    return
  fi
  # Legacy naming used _SVC_ID/_SVC_SECRET for some newer clients; prefer the
  # canonical _SVC_CLIENT_ID/_SVC_CLIENT_SECRET names, but fall back.
  cid=$(_read_env_var "CF_ACCESS_${_tk}_SVC_CLIENT_ID" "$SECRETS_ENV")
  if [ -z "$cid" ]; then
    cid=$(_read_env_var "CF_ACCESS_${_tk}_SVC_ID" "$SECRETS_ENV")
  fi
  csec=$(_read_env_var "CF_ACCESS_${_tk}_SVC_CLIENT_SECRET" "$SECRETS_ENV")
  if [ -z "$csec" ]; then
    csec=$(_read_env_var "CF_ACCESS_${_tk}_SVC_SECRET" "$SECRETS_ENV")
  fi
  if [ -z "$cid" ] || [ -z "$csec" ]; then
    echo "${client}|${persona}|${sshuser}|${tunnelhost}|unknown|UNKNOWN|DOWN|missing_cf_service_token_${_tk}"
    return
  fi
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "${client}|${persona}|${sshuser}|${tunnelhost}|unknown|UNKNOWN|DOWN|cloudflared_not_found"
    return
  fi

  # Resolve cloudflared by ABSOLUTE path. In the OpenClaw cron/exec environment
  # the ProxyCommand subshell may not inherit a PATH that includes Homebrew, so
  # a bare `cloudflared` silently fails and the whole probe reports a blind
  # rc255 / "Connection closed by UNKNOWN".
  local CFD="/opt/homebrew/bin/cloudflared"
  [ -x "$CFD" ] || CFD="$(command -v cloudflared 2>/dev/null || echo cloudflared)"
  local proxy
  proxy="ProxyCommand=${CFD} access ssh --hostname %h --service-token-id ${cid} --service-token-secret ${csec}"

  # Hard watchdog per attempt: CF_TUNNEL_TIMEOUT (default 45s).
  # ConnectTimeout MUST be < CF_TUNNEL_TIMEOUT so the inner SSH gives up
  # before the perl watchdog fires — otherwise the watchdog SIGTERMs ssh
  # but the cloudflared ProxyCommand subprocess survives and keeps the probe
  # alive past the watchdog deadline (the banner-hang root cause).
  local _ssh_ct=$(( CF_TUNNEL_TIMEOUT - 10 ))
  [[ $_ssh_ct -lt 5 ]] && _ssh_ct=5

  # Run the remote checks as SEPARATE, well-quoted commands instead of one
  # fragile single-quoted compound heredoc. We pass a here-doc script over the
  # SSH session's stdin and run it with `zsh -ls` (login + read-from-stdin) so
  # node/openclaw/curl are on PATH and there is no nested-quoting hazard that
  # can silently truncate the command over the tunnel (a false-DOWN cause).
  #
  # The remote script emits exactly one line: "<version>|<OK|DOWN>".
  local remote_script
  remote_script='
V="$(openclaw --version 2>/dev/null | head -n1)"
[ -z "$V" ] && V=unknown
if curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null 2>&1; then
  H=OK
else
  H=DOWN
fi
printf "%s|%s\n" "$V" "$H"
'

  # Single attempt helper. Prints the raw remote line on success (rc 0 + output)
  # or nothing on failure; sets _attempt_rc / _attempt_err for the caller.
  local out rc err
  _mac_attempt() {
    err="$(mktemp 2>/dev/null || echo /tmp/probe_mac_err.$$)"
    # Feed the script over stdin; `zsh -ls` reads it. Kill the whole process
    # group on timeout so the cloudflared ProxyCommand subprocess dies too.
    out=$(printf '%s' "$remote_script" | HOME="${HOME:-/Users/blackceomacmini}" _TIMEOUT "$CF_TUNNEL_TIMEOUT" ssh \
      -i "$SSH_KEY" \
      -o "$proxy" \
      -o BatchMode=yes -o ConnectTimeout=${_ssh_ct} \
      -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts \
      "${sshuser}@${tunnelhost}" "zsh -ls" 2>"$err")
    rc=$?
  }

  # First attempt.
  _mac_attempt
  # CONFIRMED RETRY: a box is only DOWN after a second failed attempt. A single
  # transient handshake glitch (banner hang, momentary connector flap) must not
  # flag a healthy box DOWN. Retry only when the first attempt clearly failed
  # (non-zero rc OR empty output OR a malformed line missing the "|" separator).
  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    rm -f "$err" 2>/dev/null
    sleep 3
    _mac_attempt
  fi

  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    local note lasterr
    note="tunnel_or_ssh_failed_rc${rc}"
    [[ $rc -eq 124 ]] && note="probe-timeout_${CF_TUNNEL_TIMEOUT}s"
    lasterr=$(tail -n1 "$err" 2>/dev/null | tr '|\r\n' '   ' | cut -c1-90)
    [[ -n "$lasterr" ]] && note="${note}:${lasterr}"
    rm -f "$err" 2>/dev/null
    echo "${client}|${persona}|${sshuser}|${tunnelhost}|unknown|UNKNOWN|DOWN|${note}"
    return
  fi
  rm -f "$err" 2>/dev/null

  local version gateway
  IFS='|' read -r version gateway <<<"$out"
  version=$(echo "$version" | tr -d '\r' | sed 's/^OpenClaw //')
  gateway=$(echo "$gateway" | tr -d '\r')
  [ -z "$gateway" ] && gateway=UNKNOWN
  echo "${client}|${persona}|${sshuser}|${tunnelhost}|${version}|${gateway}|OK|mac-tunnel"
}

# Probe a Contabo client. Access is the `contabo-host` SSH alias (HostName/User/
# IdentityFile resolved from ~/.ssh/config — NOT root@IP), then
# `docker exec -u node oc-<slug>` for version + gateway health. The "ip" and
# "container" columns both carry the container name (oc-<slug>). Any failure ->
# DOWN, never a crash. notes="contabo" so the auto-update step below skips these
# pinned-image, client-funded boxes.
probe_contabo() {
  local client="$1" persona="$2" ipcol="$3" container="$4"
  local remote_script out rc
  remote_script="
C='${container}'
V=\$(docker exec -u node \"\$C\" openclaw --version 2>/dev/null | head -n1)
[ -z \"\$V\" ] && V=unknown
if docker exec -u node \"\$C\" sh -c 'curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null 2>&1'; then
  H=OK
else
  H=DOWN
fi
printf '%s|%s\n' \"\$V\" \"\$H\"
"
  _contabo_attempt() {
    out=$(printf '%s' "$remote_script" | _TIMEOUT "$PROBE_TIMEOUT" ssh \
      -o BatchMode=yes -o ConnectTimeout=8 \
      -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
      -o StrictHostKeyChecking=accept-new \
      contabo-host "sh -s" 2>/dev/null)
    rc=$?
  }
  _contabo_attempt
  # CONFIRMED RETRY: only declare DOWN after a second failed attempt.
  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    sleep 3
    _contabo_attempt
  fi
  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    local note="contabo_ssh_or_docker_failed_rc${rc}"
    [[ $rc -eq 124 ]] && note="contabo_timeout_${PROBE_TIMEOUT}s"
    echo "${client}|${persona}|${ipcol}|${container}|unknown|UNKNOWN|DOWN|${note}"
    return
  fi
  local version gateway
  IFS='|' read -r version gateway <<<"$out"
  version=$(echo "$version" | tr -d '\r' | sed 's/^OpenClaw //')
  gateway=$(echo "$gateway" | tr -d '\r')
  [ -z "$gateway" ] && gateway=UNKNOWN
  echo "${client}|${persona}|${ipcol}|${container}|${version}|${gateway}|OK|contabo"
}

probe_one() {
  local row="$1"
  local client persona ip container ctype
  IFS='|' read -r client persona ip container ctype <<<"$row"
  ctype="${ctype:-vps}"

  # Smoke-test escape hatch.
  if [[ -n "$SIMULATE_DOWN" ]] && [[ ",${SIMULATE_DOWN}," == *",${client},"* ]]; then
    echo "${client}|${persona}|${ip}|${container}|simulated|DOWN|OK|simulated_failure"
    return
  fi

  # Contabo clients (shared contabo-host SSH alias + docker exec -u node).
  # For these rows: ip = container name, container = container name.
  if [[ "$ctype" == contabo* ]]; then
    probe_contabo "$client" "$persona" "$ip" "$container"
    return
  fi

  # Mac-tunnel clients (CF tunnel + Access service token, no Docker, no root).
  # For these rows: ip = SSH user, container = tunnel hostname.
  if [[ "$ctype" == mac-tunnel* ]]; then
    probe_mac_tunnel "$client" "$persona" "$ip" "$container"
    return
  fi

  # One SSH call per VPS. Instead of a fragile multiline-continuation compound
  # command (prone to silent truncation/quoting drift over SSH → false-DOWN),
  # feed a clean script over stdin and run it with `sh -s`. The script emits
  # exactly one line: "<version>|<OK|DOWN>". The container name is interpolated
  # into a variable inside the script (no nested-quote hazard).
  local remote_script
  remote_script="
C='${container}'
V=\$(docker exec -u node \"\$C\" openclaw --version 2>/dev/null | head -n1)
[ -z \"\$V\" ] && V=unknown
if docker exec -u node \"\$C\" sh -c 'curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null 2>&1'; then
  H=OK
else
  H=DOWN
fi
printf '%s|%s\n' \"\$V\" \"\$H\"
"

  local out rc
  _vps_attempt() {
    out=$(printf '%s' "$remote_script" | _TIMEOUT "$PROBE_TIMEOUT" ssh $SSH_OPTS "root@${ip}" "sh -s" 2>/dev/null)
    rc=$?
  }

  # First attempt.
  _vps_attempt
  # CONFIRMED RETRY: only declare DOWN after a second failed attempt, so a
  # transient SSH glitch can never flag a healthy VPS DOWN. Retry when the
  # first attempt failed (non-zero rc, empty output, or a malformed line).
  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    sleep 3
    _vps_attempt
  fi

  if [[ $rc -ne 0 || -z "$out" || "$out" != *"|"* ]]; then
    local note="ssh_or_docker_failed_rc${rc}"
    [[ $rc -eq 124 ]] && note="timeout_${PROBE_TIMEOUT}s"
    echo "${client}|${persona}|${ip}|${container}|unknown|UNKNOWN|DOWN|${note}"
    return
  fi

  local version gateway
  IFS='|' read -r version gateway <<<"$out"
  version=$(echo "$version" | tr -d '\r' | sed 's/^OpenClaw //')
  gateway=$(echo "$gateway" | tr -d '\r')
  echo "${client}|${persona}|${ip}|${container}|${version}|${gateway}|OK|"
}

# Fan out probes in parallel.
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

i=0
for row in "${ROSTER[@]}"; do
  probe_one "$row" >"${tmpdir}/${i}" &
  i=$((i+1))
done
wait

# Emit results in roster order.
for j in $(seq 0 $((i-1))); do
  cat "${tmpdir}/${j}"
done

# ----------------------------------------------------------
# VERSION-CHECK + AUTO-UPDATE (v10.15.42 / v10.16.41 deploy wiring)
# For each reachable client whose .onboarding-version is behind the
# repo's current version, run update-skills.sh automatically if the
# inferred risk is LOW or MEDIUM (same rule as cron-prompt.txt RULE 9).
#
# Risk is inferred from the CHANGELOG: the probe fetches the repo /version
# and the first risk_hint from CHANGELOG.md. If risk_hint is absent or
# "low"/"medium", auto-update fires. "high" risk skips — waits for the
# Sunday cron to ask the client.
#
# This step is ADDITIVE and SAFE:
#   • Only runs on clients that are SSH-reachable (ssh=OK in probe output)
#   • Skips any client whose probe showed DOWN or UNKNOWN
#   • Never deletes anything — update-skills.sh is additive-only
#   • Logs every action to $PROBE_UPDATE_LOG (default /tmp/probe-fleet-updates.log)
#   • Will not run during smoke-test mode
# ----------------------------------------------------------
# NOTE: every human-readable "[version-check] ..." status line below is written
# to STDERR (>&2), NOT stdout. The probe's stdout is a strict pipe-delimited
# client roster that heartbeat.sh parses line-by-line; a stray non-roster line
# on stdout was being mis-parsed as a phantom client (e.g. a change-log entry
# titled "[version-check] skipped, last run ..."). Diagnostics go to stderr +
# the update log; only client rows go to stdout.
if [ "${HEARTBEAT_MODE:-}" = "smoke-test" ]; then
  echo "[version-check] smoke-test mode — skipping auto-update step" >&2
else
  PROBE_UPDATE_LOG="${PROBE_UPDATE_LOG:-/tmp/probe-fleet-updates.log}"

  # ----------------------------------------------------------
  # DAILY GATE: version-check + auto-deploy runs AT MOST ONCE per 24h.
  # The marker file records the epoch of the last run; if it is less
  # than 86400 seconds old we skip the entire block and let the health
  # probes (above) run as normal.
  # ----------------------------------------------------------
  _VERSION_MARKER="${HOME:-/Users/blackceomacmini}/clawd/fleet-heartbeat/.last-version-deploy-check"
  _now_epoch=$(date +%s)
  _skip_version_check=0
  if [ -f "$_VERSION_MARKER" ]; then
    _last_epoch=$(cat "$_VERSION_MARKER" 2>/dev/null | tr -d '[:space:]')
    if [[ "$_last_epoch" =~ ^[0-9]+$ ]]; then
      _age=$(( _now_epoch - _last_epoch ))
      if [ "$_age" -lt 86400 ]; then
        _last_ts=$(date -r "$_VERSION_MARKER" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -d "@${_last_epoch}" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "@${_last_epoch}")
        echo "[version-check] skipped, last run ${_last_ts} (${_age}s ago, threshold 86400s)" >&2
        _skip_version_check=1
      fi
    fi
  fi

  if [ "$_skip_version_check" -eq 1 ]; then
    : # entire version-check/deploy block skipped — health probes already ran above
  else
  # Write / update the marker so the NEXT hourly run sees it
  printf '%s\n' "$_now_epoch" > "$_VERSION_MARKER"

  # Fetch repo versions (one call each; non-fatal on failure)
  REPO_VER_MAC=$(curl -fsSL --max-time 10 \
    "https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding/main/version" 2>/dev/null | tr -d '[:space:]') || REPO_VER_MAC=""
  REPO_VER_VPS=$(curl -fsSL --max-time 10 \
    "https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding-vps/main/version" 2>/dev/null | tr -d '[:space:]') || REPO_VER_VPS=""

  # Infer risk from CHANGELOG first line (risk_hint field or keyword scan)
  _infer_risk() {
    local repo_url="$1"  # raw base URL (no trailing slash)
    local cl
    cl=$(curl -fsSL --max-time 10 "${repo_url}/CHANGELOG.md" 2>/dev/null | head -30) || cl=""
    # Look for explicit risk tag in the top entry (### Risk block or risk_hint: tag)
    if echo "$cl" | grep -qi "risk.*high\|high.*risk"; then
      echo "high"
    elif echo "$cl" | grep -qi "breaking\|migration\|schema\|deprecated model\|API version"; then
      echo "high"
    else
      echo "medium"  # default to medium (auto-applies per RULE 9)
    fi
  }

  RISK_MAC=$(_infer_risk "https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding/main")
  RISK_VPS=$(_infer_risk "https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding-vps/main")

  echo "[version-check] Repo versions — Mac: ${REPO_VER_MAC:-unknown}  VPS: ${REPO_VER_VPS:-unknown}" >> "$PROBE_UPDATE_LOG"
  echo "[version-check] Inferred risk — Mac: $RISK_MAC  VPS: $RISK_VPS" >> "$PROBE_UPDATE_LOG"

  # Re-read results and check each reachable client
  for j in $(seq 0 $((i-1))); do
    result_line=$(cat "${tmpdir}/${j}" 2>/dev/null) || continue
    [ -z "$result_line" ] && continue

    IFS='|' read -r _client _persona _ip _container _ver _gw _ssh _notes <<<"$result_line"
    # Only update clients that are SSH-reachable and have a version we can compare
    [ "$_ssh" != "OK" ] && continue
    [ "$_ver" = "unknown" ] && continue

    # Contabo boxes run a PINNED image on the client's OWN funded keys — they are
    # health-probed (above) but NEVER auto-rolled a skill/version update here.
    case "$_notes" in *contabo*) echo "[version-check] $_client: contabo (pinned image / client-funded) — health-probed, auto-update skipped" >&2; continue ;; esac

    # Determine type (mac-tunnel or vps) based on notes or container field
    if echo "$_notes" | grep -q "mac-tunnel"; then
      REPO_VER="$REPO_VER_MAC"
      REPO_RISK="$RISK_MAC"
      UPDATE_CMD='bash <(curl -fsSL https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding/main/update-skills.sh)'
    else
      REPO_VER="$REPO_VER_VPS"
      REPO_RISK="$RISK_VPS"
      UPDATE_CMD='bash <(curl -fsSL https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding-vps/main/update-skills.sh)'
    fi

    [ -z "$REPO_VER" ] && continue
    # Normalize: strip leading 'v', compare
    _local_norm="${_ver#v}"
    _repo_norm="${REPO_VER#v}"
    [ "$_local_norm" = "$_repo_norm" ] && continue  # already current

    # Client is behind
    echo "[version-check] $_client is behind: local=$_ver repo=$REPO_VER risk=$REPO_RISK" >> "$PROBE_UPDATE_LOG"
    echo "[version-check] $_client is behind ($REPO_RISK risk): $REPO_VER available (current: $_ver)" >&2

    if [ "$REPO_RISK" = "high" ]; then
      echo "[version-check] $_client: HIGH risk — skipping auto-update, Sunday cron will prompt" >> "$PROBE_UPDATE_LOG"
      echo "[version-check] $_client: HIGH risk — will wait for Sunday cron" >&2
      continue
    fi

    # LOW or MEDIUM: auto-apply
    echo "[version-check] $_client: auto-applying $REPO_RISK-risk update..." >> "$PROBE_UPDATE_LOG"
    echo "[version-check] $_client: auto-applying ($REPO_RISK risk)..." >&2

    # Mac-tunnel clients: SSH over CF tunnel + Access token
    if echo "$_notes" | grep -q "mac-tunnel"; then
      # Pull the same CF credentials used in probe_mac_tunnel
      local _tk2
      case "$_client" in
        *Cassandra*) _tk2=CASSANDRA ;;
        *Kofi*)      _tk2=KOFI ;;
        *Teresa*)    _tk2=TERESA ;;
        *Karen*)     _tk2=KAREN ;;
        *Jill*)      _tk2=JILL ;;
        *Sheila*)    _tk2=SHEILA ;;
        *Aurelia*)   _tk2=AURELIA ;;
        *LeAnne*)    _tk2=LEANNE_DOLCE ;;
        *Sonatta*)   _tk2=SONATTA_CAMARA ;;
        *Talaya*)    _tk2=TALAYA ;;
        *Stephanie*) _tk2=STEPHANIE ;;
        *Jocelyn*)   _tk2=JOCELYN ;;
        *"Barret Matthews (Mac Mini"*)    _tk2=BARRETT_MINI ;;
        *Barret*)    _tk2=BARRET ;;
        *"Jennifer Allen"*)    _tk2=JENNIFER ;;
        *"E.R. Spaulding"*)    _tk2=ER_SPAULDING ;;
        *Eddie*)     _tk2=EDDIE_OTTS ;;
        *Maria*)     _tk2=MARIA ;;
        *Christy*)   _tk2=CHRISTY ;;
        *Erin*)      _tk2=ERIN ;;
        *Lyric*)     _tk2=LYRIC_HAWKINS ;;
        *Star*)      _tk2=STAR ;;
        # No match: FAIL LOUDLY, same reasoning as probe_mac_tunnel() above.
        # Never borrow another client's token to drive an update run either.
        *)           _tk2="" ;;
      esac
      if [ -z "$_tk2" ]; then
        echo "[version-check] $_client: no CF token mapping in probe-fleet.sh — skipping auto-update (config error, add a case to probe_mac_tunnel()/this switch)" >&2
        continue
      fi
      _cid2=$(_read_env_var "CF_ACCESS_${_tk2}_SVC_CLIENT_ID" "$SECRETS_ENV")
      _csec2=$(_read_env_var "CF_ACCESS_${_tk2}_SVC_CLIENT_SECRET" "$SECRETS_ENV")
      CFD="/opt/homebrew/bin/cloudflared"
      [ -x "$CFD" ] || CFD="$(command -v cloudflared 2>/dev/null || echo cloudflared)"
      _proxy2="ProxyCommand=${CFD} access ssh --hostname %h --service-token-id ${_cid2} --service-token-secret ${_csec2}"
      _ssh_ct2=$(( CF_TUNNEL_TIMEOUT - 10 ))
      [[ $_ssh_ct2 -lt 5 ]] && _ssh_ct2=5
      update_out=$(HOME="${HOME:-/Users/blackceomacmini}" _TIMEOUT "$CF_TUNNEL_TIMEOUT" ssh \
        -i "$SSH_KEY" \
        -o "$_proxy2" \
        -o BatchMode=yes -o ConnectTimeout=${_ssh_ct2} \
        -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
        -o StrictHostKeyChecking=accept-new \
        -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts \
        "${_ip}@${_container}" \
        "zsh -lc '$UPDATE_CMD'" 2>&1) || true
    else
      # VPS: SSH + docker exec (update-skills.sh auto-detects container)
      update_out=$(_TIMEOUT "$PROBE_TIMEOUT" ssh $SSH_OPTS "root@${_ip}" \
        "curl -fsSL https://raw.githubusercontent.com/trevorotts1/openclaw-onboarding-vps/main/update-skills.sh | bash" 2>&1) || true
    fi

    echo "[version-check] $_client update output (tail):" >> "$PROBE_UPDATE_LOG"
    echo "$update_out" | tail -10 >> "$PROBE_UPDATE_LOG"
    echo "---" >> "$PROBE_UPDATE_LOG"
    echo "[version-check] $_client: update triggered (see $PROBE_UPDATE_LOG for output)" >&2
  done

  echo "[version-check] Done. $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PROBE_UPDATE_LOG"
  fi  # end: daily gate (version-check ran)
fi    # end: smoke-test guard
