#!/usr/bin/env bash
# Fleet remediation: Remote Rescue posture for a single DOWN client.
#
# Usage:
#   remediate.sh <client> <persona> <ip> <container> <version> <gateway> <ssh> <notes>
#
# Behavior:
#   1. SSH into the box. Capture container state + last 50 log lines + most
#      recent stability bundle id (if any).
#   2. Classify the failure into one of:
#        config-invalid       agents.list schema validation errors
#        container-exited     container is not running / exited / OOM
#        gateway-port-closed  container running but :18789 not listening
#        gateway-auth         gateway healthy on the box but auth/token error
#        unknown              none of the above match cleanly
#   3. Attempt remediation per class (no auto-fix on gateway-auth or unknown).
#   4. Re-probe up to REMEDIATE_TIMEOUT seconds (default 90) for gateway to return OK.
#   5. Append a change-log entry to ../change-log.md (atomic >> append).
#   6. Emit a single result block on stdout that the orchestrator parses:
#        ===REMEDIATE-RESULT===
#        client=<name>
#        class=<failure-class>
#        outcome=<FIXED|UNFIXED|SKIPPED>
#        ttr_seconds=<int>
#        tried=<semicolon-separated commands>
#        diag=<short diag blob>
#        pattern=<NONE|REPEAT|FLEET-WIDE|REPEAT+FLEET-WIDE>
#        ===END===
#
# Hard rules:
#   * No em dashes in user-visible output (Telegram lines).
#   * Idempotent. If the box is already healthy when we arrive, classify as
#     "already-up" and exit FIXED with zero commands tried.
#   * Append-only to change-log.md via `>>`.

set -u

CLIENT="$1"
PERSONA="$2"
IP="$3"
CONTAINER="$4"
VERSION="$5"
GATEWAY="$6"
SSH_STATE="$7"
NOTES="$8"

# ---- DRY-RUN + forced-class (RR #5: structured fixer wired into the relay) ----
# REMEDIATE_DRY_RUN=1  -> never execute a mutating command; only PLAN it. Used by
#   the rescue receiver so a fix-it-ourselves ticket carries a REAL structured fix
#   plan (not just LLM advice). Read-only diagnostics are unaffected; the
#   change-log is NOT written in dry-run.
# REMEDIATE_FORCE_CLASS=<class> -> skip live diagnostics/SSH and plan for that
#   class directly (deterministic, zero-network). Honored ONLY in DRY-RUN.
DRY_RUN="${REMEDIATE_DRY_RUN:-${DRY_RUN:-0}}"
FORCE_CLASS="${REMEDIATE_FORCE_CLASS:-}"

# ---- Inner recovery wall (env-respecting) -----------------------------------
# REMEDIATE_TIMEOUT bounds (a) how long we wait for the gateway to come back after
# a remediation, and (b) how long the long mutating command (container rebuild via
# compose up --force-recreate, which may re-pull a large image) is allowed to run.
# The rescue receiver passes this through so a legit long fix (rebuild / reinstall /
# re-onboard) is NOT cut at the old hardcoded 90s. Standalone default stays 90s, so
# behavior outside the receiver is unchanged. The per-class escalate decision still
# lives in the receiver; this just stops remediate.sh from giving up too early.
REMEDIATE_TIMEOUT="${REMEDIATE_TIMEOUT:-90}"
case "$REMEDIATE_TIMEOUT" in ''|*[!0-9]*) REMEDIATE_TIMEOUT=90 ;; esac

ROOT="/Users/blackceomacmini/clawd/fleet-heartbeat"
CHANGE_LOG="${ROOT}/change-log.md"
SSH_KEY="${SSH_KEY:-/Users/blackceomacmini/.ssh/id_ed25519}"
SSH_OPTS="-i ${SSH_KEY} -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts"

# ---- Platform classification: VPS-Docker vs Mac-tunnel ----------------------
#
# The probe passes us the SAME 8 fields it emits per client. For VPS clients
# the "ip" field is a real public IP and "container" is a docker container
# name; for Mac-tunnel clients the "ip" field is actually the SSH USER and the
# "container" field is the Cloudflare tunnel HOSTNAME (rescue-*.zerohuman...).
# The probe also tags mac-tunnel rows in the "notes" field with "mac-tunnel"
# (healthy) or "tunnel_or_ssh_failed_rc..." / "probe-timeout..." / "missing_cf
# _service_token..." / "cloudflared_not_found" (down).
#
# A Mac client must NEVER be docker-inspected (it has no Docker), so we detect
# the platform up front and branch the entire diagnostic + remediation path.
# Detection is belt-and-suspenders: the tunnel-hostname shape is the primary
# signal (it survives even when notes is empty), notes keywords are the backup.
PLATFORM="vps"
case "$CONTAINER" in
  rescue-*.zerohumanworkforce.com|*.cfargotunnel.com) PLATFORM="mac-tunnel" ;;
esac
case "$NOTES" in
  *mac-tunnel*|*tunnel_or_ssh_failed*|*probe-timeout*|*missing_cf_service_token*|*cloudflared_not_found*) PLATFORM="mac-tunnel" ;;
esac
# A real VPS row never carries a tunnel hostname in CONTAINER; a real VPS IP is
# dotted-decimal. If CONTAINER ends in "-openclaw-1" it is definitively Docker.
case "$CONTAINER" in
  *-openclaw-1) PLATFORM="vps" ;;
esac

# ---- DRY-RUN PLANNER (zero SSH, zero mutation) ------------------------------
# When DRY-RUN is on AND a class is forced, emit the PLANNED remediation for that
# class and exit. This is the path the rescue receiver uses to attach a concrete,
# structured fix plan to a fix-it-ourselves ticket without ever touching the box.
if [ "$DRY_RUN" = "1" ] && [ -n "$FORCE_CLASS" ]; then
  _ps=$(echo "$CONTAINER" | sed 's/-openclaw-1$//'); _pd="/docker/${_ps}"
  # Per-box shell for Mac plans: Barret's Mac uses bash; all others use zsh.
  _mshell="zsh"; case "$CONTAINER" in rescue-barret-matthews*) _mshell="bash" ;; esac
  case "$FORCE_CLASS" in
    config-invalid)       _plan="docker exec -u node ${CONTAINER} openclaw doctor --fix; docker restart ${CONTAINER}" ;;
    container-exited)     _plan="docker compose -f ${_pd}/docker-compose.yml up -d --force-recreate" ;;
    gateway-port-closed)  _plan="docker restart ${CONTAINER}" ;;
    mac-config-invalid)   _plan="${_mshell} -lc 'openclaw config validate'; ${_mshell} -lc 'openclaw doctor --fix'; launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway" ;;
    mac-gateway-down)     _plan="launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway" ;;
    gateway-auth|unknown) _plan="(no auto-fix for this class; surface to a human)" ;;
    *)                    _plan="(unrecognized class; surface to a human)" ;;
  esac
  cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${FORCE_CLASS}
outcome=DRYRUN
ttr_seconds=0
tried=[DRY-RUN] ${_plan}
diag=dry-run planner (no ssh, no mutation)
pattern=NONE
root_cause=DRY-RUN plan for ${FORCE_CLASS}; no command executed
===END===
EOF
  exit 0
fi

# Mac-tunnel access: SSH over a Cloudflare tunnel + Access service token, NOT
# root@IP. Resolve the per-client service token by client name (same mapping as
# probe-fleet.sh) and the absolute cloudflared path (the OpenClaw cron/exec env
# does not always have Homebrew on PATH).
SECRETS_ENV="${SECRETS_ENV:-/Users/blackceomacmini/.openclaw/secrets/.env}"
CF_TUNNEL_TIMEOUT="${CF_TUNNEL_TIMEOUT:-45}"
export PATH="/opt/homebrew/bin:$PATH"

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

# Map a client name to its CF Access service-token env-var stem (mirror of the
# case block in probe-fleet.sh::probe_mac_tunnel — keep the two in sync).
_token_stem_for_client() {
  case "$1" in
    *Cassandra*) echo CASSANDRA ;;
    *Kofi*)      echo KOFI ;;
    *Teresa*)    echo TERESA ;;
    *Karen*)     echo KAREN ;;
    *Jill*)      echo JILL ;;
    *Sheila*)    echo SHEILA ;;
    *Aurelia*)   echo AURELIA ;;
    *LeAnne*)    echo LEANNE_DOLCE ;;
    *Sonatta*)   echo SONATTA_CAMARA ;;
    *Talaya*)    echo TALAYA ;;
    *Stephanie*) echo STEPHANIE ;;
    *Jocelyn*)   echo JOCELYN ;;
    *Barret*)    echo BARRET ;;
    *Maria*)     echo MARIA ;;
    *Christy*)   echo CHRISTY ;;
    *Erin*)      echo ERIN ;;
    *Lyric*)     echo LYRIC_HAWKINS ;;
    *Star*)      echo STAR ;;
    *)           echo TERESA ;;
  esac
}

# Legacy naming used _SVC_ID/_SVC_SECRET for some newer clients; prefer the
# canonical _SVC_CLIENT_ID/_SVC_CLIENT_SECRET names, but fall back.
read_cf_access_token() {
  local stem="$1" file="$2" cid csec
  cid=$(_read_env_var "CF_ACCESS_${stem}_SVC_CLIENT_ID" "$file")
  [ -z "$cid" ] && cid=$(_read_env_var "CF_ACCESS_${stem}_SVC_ID" "$file")
  csec=$(_read_env_var "CF_ACCESS_${stem}_SVC_CLIENT_SECRET" "$file")
  [ -z "$csec" ] && csec=$(_read_env_var "CF_ACCESS_${stem}_SVC_SECRET" "$file")
  printf '%s\n%s\n' "$cid" "$csec"
}

_TIMEOUT_WRAPPER="${ROOT}/scripts/_timeout.pl"
if command -v timeout >/dev/null 2>&1; then
  _TIMEOUT() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  _TIMEOUT() { gtimeout "$@"; }
else
  _TIMEOUT() { perl "$_TIMEOUT_WRAPPER" "$@"; }
fi

ssh_run() {
  # ssh_run <timeout_secs> <remote_cmd>  (VPS path: root@IP)
  local t="$1"; shift
  _TIMEOUT "$t" ssh $SSH_OPTS "root@${IP}" "$@" 2>/dev/null
}

# mac_ssh_run <timeout_secs> <remote_cmd>
# Run a command on a Mac-tunnel client over the Cloudflare tunnel + Access
# service token. IP holds the SSH user; CONTAINER holds the tunnel hostname.
# The remote command is wrapped in a LOGIN shell so node/openclaw are on PATH.
# Returns the command's stdout; empty on any access-chain failure.
mac_ssh_run() {
  local t="$1"; shift
  local remote="$1"
  local stem cid csec cfd proxy ct
  local token_pair; token_pair=$(read_cf_access_token "$stem" "$SECRETS_ENV")
  cid=$(echo "$token_pair" | sed -n '1p')
  csec=$(echo "$token_pair" | sed -n '2p')
  local token_pair; token_pair=$(read_cf_access_token "$stem" "$SECRETS_ENV")
  cid=$(echo "$token_pair" | sed -n '1p')
  csec=$(echo "$token_pair" | sed -n '2p')
  local token_pair; token_pair=$(read_cf_access_token "$stem" "$SECRETS_ENV")
  cid=$(echo "$token_pair" | sed -n '1p')
  csec=$(echo "$token_pair" | sed -n '2p')
  local token_pair; token_pair=$(read_cf_access_token "$stem" "$SECRETS_ENV")
  cid=$(echo "$token_pair" | sed -n '1p')
  csec=$(echo "$token_pair" | sed -n '2p')
  cfd="/opt/homebrew/bin/cloudflared"
  [ -x "$cfd" ] || cfd="$(command -v cloudflared 2>/dev/null || echo cloudflared)"
  proxy="ProxyCommand=${cfd} access ssh --hostname %h --service-token-id ${cid} --service-token-secret ${csec}"
  ct=$(( t - 5 )); [ "$ct" -lt 5 ] && ct=5
  HOME="${HOME:-/Users/blackceomacmini}" _TIMEOUT "$t" ssh \
    -i "$SSH_KEY" \
    -o "$proxy" \
    -o BatchMode=yes -o ConnectTimeout=${ct} \
    -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/Users/blackceomacmini/.ssh/known_hosts \
    "${IP}@${CONTAINER}" "$remote" 2>/dev/null
}

# probe_mac_gateway: confirm the Mac gateway health endpoint over the tunnel.
# Prints OK | DOWN | UNKNOWN. Uses a LOGIN shell so curl/openclaw are found.
probe_mac_gateway() {
  local out
  out=$(mac_ssh_run "$CF_TUNNEL_TIMEOUT" 'zsh -lc '\''curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null 2>&1 && echo OK || echo DOWN'\''')
  out=$(echo "$out" | tr -d '\r' | head -n1)
  [ -z "$out" ] && out="UNKNOWN"
  echo "$out"
}

# Probe gateway via SSH+docker exec curl to :18789/health.
probe_gateway() {
  local out
  out=$(ssh_run 15 "docker exec -u node ${CONTAINER} sh -c 'curl -sf -m 5 http://127.0.0.1:18789/health >/dev/null && echo OK || echo DOWN' 2>/dev/null")
  out=$(echo "$out" | tr -d '\r' | head -n1)
  [ -z "$out" ] && out="UNKNOWN"
  echo "$out"
}

# Wait up to REMEDIATE_TIMEOUT seconds for gateway to come back OK. Returns seconds
# elapsed if OK, or "TIMEOUT" if it never returned. Polls every 10s.
wait_for_gateway() {
  local start=$(date +%s)
  local deadline=$((start + REMEDIATE_TIMEOUT))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local g
    g=$(probe_gateway)
    if [ "$g" = "OK" ]; then
      echo $(( $(date +%s) - start ))
      return 0
    fi
    sleep 10
  done
  echo "TIMEOUT"
  return 1
}

# Pattern detection on change-log:
#   REPEAT       = same client + same class in last 7 days, >=2 occurrences (including this one)
#   FLEET-WIDE   = same class hit on >=3 distinct clients in last 30 days
pattern_flag() {
  local class="$1"
  local now_epoch
  now_epoch=$(date +%s)
  local week_ago=$((now_epoch - 7*86400))
  local month_ago=$((now_epoch - 30*86400))

  [ -f "$CHANGE_LOG" ] || { echo "NONE"; return; }

  # Each entry header line:   ## 2026-MM-DD HH:MM EDT, <Client>
  # Followed by a            - Failure: <class>
  # Use perl: portable on macOS without gawk/coreutils.
  local report
  report=$(perl -e '
    use strict; use warnings; use Time::Local;
    my ($class, $client, $week, $month, $file) = @ARGV;
    open(my $fh, "<", $file) or exit;
    my ($cur_cli, $cur_epoch) = ("", 0);
    my $repeat = 0;
    my $distinct = 0;
    my %seen;
    while (my $line = <$fh>) {
      if ($line =~ /^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) [^,]*, (.+?)\s*$/) {
        my ($yy,$mm,$dd,$hh,$mi,$cli) = ($1,$2,$3,$4,$5,$6);
        $cur_cli = $cli;
        eval { $cur_epoch = timelocal(0, $mi, $hh, $dd, $mm-1, $yy-1900); 1 } or $cur_epoch = 0;
      } elsif ($line =~ /^- Failure:\s*(.+?)\s*$/) {
        my $cls = $1;
        if ($cur_epoch >= $week && $cur_cli eq $client && $cls eq $class) { $repeat++; }
        if ($cur_epoch >= $month && $cls eq $class) {
          unless ($seen{$cur_cli}) { $seen{$cur_cli} = 1; $distinct++; }
        }
      }
    }
    print "repeat=$repeat distinct=$distinct\n";
  ' "$class" "$CLIENT" "$week_ago" "$month_ago" "$CHANGE_LOG")

  local r d
  r=$(echo "$report" | sed -n 's/.*repeat=\([0-9]*\).*/\1/p')
  d=$(echo "$report" | sed -n 's/.*distinct=\([0-9]*\).*/\1/p')
  [ -z "$r" ] && r=0
  [ -z "$d" ] && d=0

  # +1 for the entry we're about to append.
  local r_incl=$((r + 1))
  local d_incl=$d
  # If this client never logged this class in the last 30 days, the new
  # entry adds a distinct client.
  if perl -e '
    use strict; use warnings; use Time::Local;
    my ($class, $client, $month, $file) = @ARGV;
    open(my $fh, "<", $file) or exit 1;
    my ($cur_cli, $cur_epoch) = ("", 0);
    while (my $line = <$fh>) {
      if ($line =~ /^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) [^,]*, (.+?)\s*$/) {
        my ($yy,$mm,$dd,$hh,$mi,$cli) = ($1,$2,$3,$4,$5,$6);
        $cur_cli = $cli;
        eval { $cur_epoch = timelocal(0, $mi, $hh, $dd, $mm-1, $yy-1900); 1 } or $cur_epoch = 0;
      } elsif ($line =~ /^- Failure:\s*(.+?)\s*$/) {
        if ($cur_epoch >= $month && $1 eq $class && $cur_cli eq $client) { exit 0; }
      }
    }
    exit 1;
  ' "$class" "$CLIENT" "$month_ago" "$CHANGE_LOG"; then
    : # client already counted in distinct set
  else
    d_incl=$((d + 1))
  fi

  local flags=""
  if [ "$r_incl" -ge 2 ]; then flags="REPEAT"; fi
  if [ "$d_incl" -ge 3 ]; then
    if [ -n "$flags" ]; then flags="${flags}+FLEET-WIDE"; else flags="FLEET-WIDE"; fi
  fi
  [ -z "$flags" ] && flags="NONE"
  echo "$flags"
}

append_change_log() {
  # DRY-RUN must never write to the change-log (no fake "fixed" entries).
  [ "${DRY_RUN:-0}" = "1" ] && return 0
  local class="$1" outcome="$2" ttr="$3" tried="$4" diag="$5" pattern="$6" root_cause="$7"
  local ts
  ts=$(date "+%Y-%m-%d %H:%M %Z")
  # Atomic append. Single >> call writes one heredoc block.
  {
    printf '\n## %s, %s\n' "$ts" "$CLIENT"
    printf -- '- Failure: %s\n' "$class"
    printf -- '- Diagnostics: %s\n' "$diag"
    printf -- '- Tried: %s\n' "$tried"
    if [ "$outcome" = "FIXED" ]; then
      printf -- '- Result: FIXED in %s seconds\n' "$ttr"
    elif [ "$outcome" = "SKIPPED" ]; then
      printf -- '- Result: SKIPPED, %s\n' "$ttr"
    else
      printf -- '- Result: UNFIXED, escalating\n'
    fi
    printf -- '- Root cause: %s\n' "$root_cause"
    if [ "$pattern" != "NONE" ]; then
      printf -- '- Pattern flag: %s\n' "$pattern"
    fi
  } >> "$CHANGE_LOG"
}

# ---- Step 1: gather diagnostics ----------------------------------------------

DIAG_BLOB=""
CLASS="unknown"
TRIED=""
OUTCOME="UNFIXED"
TTR="0"
ROOT_CAUSE="investigating"

# ============================================================================
# MAC-TUNNEL PATH (no Docker, no root@IP). Branch the ENTIRE diagnostic +
# remediation flow so a Mac client never runs `docker inspect` and therefore
# never produces a bogus state=inspect_failed / port18789=unknown blob.
# ============================================================================
if [ "$PLATFORM" = "mac-tunnel" ]; then
  # Step 1: re-confirm reachability over the tunnel before declaring anything.
  # The probe may have flagged DOWN on a transient handshake glitch; a single
  # confirm here prevents remediate.sh from logging false failures too.
  MAC_REACH=$(mac_ssh_run "$CF_TUNNEL_TIMEOUT" 'echo REACHABLE'); MAC_REACH=$(echo "$MAC_REACH" | tr -d '\r' | head -n1)

  if [ "$MAC_REACH" = "REACHABLE" ]; then
    # Tunnel + SSH are fine. Check the gateway health endpoint and launchctl.
    GW=$(probe_mac_gateway)
    if [ "$GW" = "OK" ]; then
      # Self-recovered (or never actually down): idempotent no-op.
      CLASS="already-up"
      DIAG_BLOB="platform=mac-tunnel; reach=ok; gateway=ok (127.0.0.1:18789/health)"
      OUTCOME="FIXED"; TTR="0"; TRIED="(none, mac-tunnel reachable + gateway OK)"
      ROOT_CAUSE="mac-tunnel client healthy; probe DOWN was transient"
      PATTERN=$(pattern_flag "$CLASS")
      append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
      cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
      exit 0
    fi

    # Reachable but gateway endpoint not answering. Determine per-box shell
    # first (Barret uses bash; all other Mac boxes use zsh), then probe for
    # config-invalid symptoms before deciding which repair to run.
    # We do NOT run `openclaw gateway restart` (it can evict a detached job
    # and take the gateway fully down). NOTE: on several Mac boxes the gateway
    # runs as a DETACHED `openclaw gateway run`; for those a kickstart
    # no-ops harmlessly and the box self-heals via its own gw-watchdog cron.
    case "$CONTAINER" in
      rescue-barret-matthews*) MAC_SHELL="bash" ;;
      *) MAC_SHELL="zsh" ;;
    esac

    # Probe config validity and gateway status (read-only; safe in both
    # dry-run and live modes). Capture output for detection + DIAG_BLOB.
    CFG_VAL_OUT=$(mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'openclaw config validate 2>&1 | tr \"\n\" \" \" | cut -c1-600'")
    CFG_VAL_OUT=$(echo "$CFG_VAL_OUT" | tr -d '\r')
    GW_STATUS=$(mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'openclaw gateway status 2>&1 | tr \"\n\" \" \" | cut -c1-400'")
    GW_STATUS=$(echo "$GW_STATUS" | tr -d '\r')

    # Classify: config-invalid if known schema/agents.list error signatures
    # appear in validate output or gateway status. Also honor FORCE_CLASS.
    MAC_CONFIG_INVALID=0
    case "${CFG_VAL_OUT} ${GW_STATUS}" in
      *"agents.list"*|*"schema validation"*|*"AgentsConfigError"*|*"InvalidAgentsList"*|*"validation failed"*|*"invalid config"*) MAC_CONFIG_INVALID=1 ;;
    esac
    [ "$FORCE_CLASS" = "mac-config-invalid" ] && MAC_CONFIG_INVALID=1

    if [ "$MAC_CONFIG_INVALID" = "1" ]; then
      # CONFIG-INVALID: validate (for the record) + doctor --fix + kickstart.
      CLASS="mac-config-invalid"
      DIAG_BLOB="platform=mac-tunnel; reach=ok; gateway=${GW} (127.0.0.1:18789/health); config_validate=${CFG_VAL_OUT}; status=${GW_STATUS}"
      DIAG_BLOB=$(printf '%s' "$DIAG_BLOB" | LC_ALL=C perl -pe 's/\xe2\x80\x94/-/g')

      cmd1="${MAC_SHELL} -lc 'openclaw config validate'"
      cmd2="${MAC_SHELL} -lc 'openclaw doctor --fix'"
      cmd3="launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway"
      TRIED="${cmd1}; ${cmd2}; ${cmd3}"

      if [ "$DRY_RUN" = "1" ]; then
        OUTCOME="DRYRUN"; TTR="0"
        ROOT_CAUSE="DRY-RUN: would run openclaw config validate; openclaw doctor --fix; then kickstart ai.openclaw.gateway; no command executed"
        PATTERN=$(pattern_flag "$CLASS")
        append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
        cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=[DRY-RUN] ${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
        exit 0
      fi

      # LIVE: run validate (capture for log), doctor --fix, then kickstart.
      mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'openclaw config validate'" >/dev/null 2>&1
      mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'openclaw doctor --fix'" >/dev/null 2>&1
      mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway >/dev/null 2>&1 || true'" >/dev/null 2>&1

      # Wait up to REMEDIATE_TIMEOUT seconds for the gateway health endpoint to return OK.
      START_EPOCH=$(date +%s)
      MAC_WAIT="TIMEOUT"
      while [ "$(date +%s)" -lt "$((START_EPOCH + REMEDIATE_TIMEOUT))" ]; do
        if [ "$(probe_mac_gateway)" = "OK" ]; then
          MAC_WAIT=$(( $(date +%s) - START_EPOCH ))
          break
        fi
        sleep 10
      done

      if [ "$MAC_WAIT" = "TIMEOUT" ]; then
        OUTCOME="UNFIXED"; TTR="${REMEDIATE_TIMEOUT}+"
        ROOT_CAUSE="mac-config-invalid; openclaw doctor --fix + launchctl kickstart did not restore :18789 within ${REMEDIATE_TIMEOUT}s (config may need manual correction)"
      else
        OUTCOME="FIXED"; TTR="$MAC_WAIT"
        ROOT_CAUSE="mac agents.list / config schema invalid, repaired by openclaw doctor --fix + launchctl kickstart of ai.openclaw.gateway"
      fi
      PATTERN=$(pattern_flag "$CLASS")
      append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
      cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
      exit 0
    fi

    # Not config-invalid: classify as mac-gateway-down and kickstart only.
    CLASS="mac-gateway-down"
    DIAG_BLOB="platform=mac-tunnel; reach=ok; gateway=${GW} (127.0.0.1:18789/health); config_validate=${CFG_VAL_OUT}; status=${GW_STATUS}"
    DIAG_BLOB=$(printf '%s' "$DIAG_BLOB" | LC_ALL=C perl -pe 's/\xe2\x80\x94/-/g')

    cmd1="launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway"
    [ "$DRY_RUN" = "1" ] || mac_ssh_run "$CF_TUNNEL_TIMEOUT" "${MAC_SHELL} -lc 'launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway >/dev/null 2>&1 || true'" >/dev/null 2>&1
    TRIED="$cmd1"

    if [ "$DRY_RUN" = "1" ]; then
      OUTCOME="DRYRUN"; TTR="0"
      ROOT_CAUSE="DRY-RUN: would kickstart ai.openclaw.gateway; no command executed"
      PATTERN=$(pattern_flag "$CLASS")
      append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
      cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=[DRY-RUN] ${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
      exit 0
    fi

    # Wait up to REMEDIATE_TIMEOUT seconds for the gateway health endpoint to return OK.
    START_EPOCH=$(date +%s)
    MAC_WAIT="TIMEOUT"
    while [ "$(date +%s)" -lt "$((START_EPOCH + REMEDIATE_TIMEOUT))" ]; do
      if [ "$(probe_mac_gateway)" = "OK" ]; then
        MAC_WAIT=$(( $(date +%s) - START_EPOCH ))
        break
      fi
      sleep 10
    done

    if [ "$MAC_WAIT" = "TIMEOUT" ]; then
      OUTCOME="UNFIXED"; TTR="${REMEDIATE_TIMEOUT}+"
      ROOT_CAUSE="mac-gateway-down; launchctl kickstart did not restore :18789 within ${REMEDIATE_TIMEOUT}s (box may run a detached gateway with its own watchdog, or need a human at the keyboard)"
    else
      OUTCOME="FIXED"; TTR="$MAC_WAIT"
      ROOT_CAUSE="mac gateway endpoint was down, restored via launchctl kickstart of ai.openclaw.gateway"
    fi
    PATTERN=$(pattern_flag "$CLASS")
    append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
    cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
    exit 0
  fi

  # Not reachable over the tunnel after a confirm: the CF tunnel / SSH access
  # chain is down (connector offline, Mac asleep, FileVault-locked after a cold
  # power loss, or a missing service token). This is NOT auto-fixable from here
  # (no Docker to restart, and we cannot wake/unlock a remote Mac), so surface
  # it for human review. CRUCIALLY: classify as mac-tunnel-unreachable, never
  # the VPS ssh-unreachable/inspect_failed classes.
  CLASS="mac-tunnel-unreachable"
  DIAG_BLOB="platform=mac-tunnel; reach=down; ssh_user=${IP}; tunnel=${CONTAINER}; probe_notes=${NOTES}"
  DIAG_BLOB=$(printf '%s' "$DIAG_BLOB" | LC_ALL=C perl -pe 's/\xe2\x80\x94/-/g')
  TRIED="(none, mac-tunnel unreachable; cannot docker-restart a Mac; not auto-fixable remotely)"
  case "$NOTES" in
    *missing_cf_service_token*) ROOT_CAUSE="CF Access service token missing for this client in secrets/.env; add CF_ACCESS_<CLIENT>_SVC_CLIENT_ID/SECRET" ;;
    *cloudflared_not_found*)    ROOT_CAUSE="cloudflared binary not found on operator box; install/verify /opt/homebrew/bin/cloudflared" ;;
    *probe-timeout*)            ROOT_CAUSE="tunnel handshake/banner hang; connector likely offline or Mac asleep/locked (cold power-loss needs a human at the keyboard)" ;;
    *)                          ROOT_CAUSE="CF tunnel/SSH access chain down; connector offline, Mac asleep, or FileVault-locked after power loss (needs a human at the keyboard)" ;;
  esac
  PATTERN=$(pattern_flag "$CLASS")
  append_change_log "$CLASS" "UNFIXED" "0" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
  cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=UNFIXED
ttr_seconds=0
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
  exit 0
fi
# ============================================================================
# VPS-DOCKER PATH (root@IP + docker). Everything below this point only runs
# for genuine VPS/Docker clients.
# ============================================================================

# If SSH itself was down at probe time, try once more before giving up.
if [ "$SSH_STATE" != "OK" ]; then
  if ! ssh_run 10 "true" >/dev/null 2>&1; then
    CLASS="ssh-unreachable"
    DIAG_BLOB="ssh failed (notes=${NOTES})"
    ROOT_CAUSE="VPS unreachable over SSH; check provider console / network"
    PATTERN=$(pattern_flag "$CLASS")
    append_change_log "$CLASS" "UNFIXED" "0" "(none, ssh down)" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
    cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=UNFIXED
ttr_seconds=0
tried=(none, ssh down)
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
    exit 0
  fi
fi

# Container state.
CONTAINER_STATE=$(ssh_run 10 "docker inspect -f '{{.State.Status}} exitcode={{.State.ExitCode}} oomkilled={{.State.OOMKilled}}' ${CONTAINER} 2>/dev/null" || echo "inspect_failed")
CONTAINER_STATE=$(echo "$CONTAINER_STATE" | tr -d '\r' | head -n1)

# Container logs (last 50 lines, single line for the blob).
# Strip ANSI escape sequences before truncation so the blob stays readable.
LOG_TAIL=$(ssh_run 12 "docker logs --tail 50 ${CONTAINER} 2>&1 | sed $'s/\x1b\\[[0-9;]*[mK]//g' | tr '\n' ' ' | cut -c1-1200" || echo "")

# Stability bundle id, if any.
STAB_ID=$(ssh_run 10 "ls -t /data/.openclaw/stability/bundles 2>/dev/null | head -n1" || echo "")
STAB_ID=$(echo "$STAB_ID" | tr -d '\r' | head -n1)
[ -z "$STAB_ID" ] && STAB_ID="none"

# Is gateway port actually listening, checked from the host (the gateway
# binds on the host via the openclaw proxy, so check at host level not inside
# the container).
PORT_LISTEN=$(ssh_run 8 "ss -ltn 2>/dev/null | grep -E ':18789|:1878[0-9]' || netstat -ltn 2>/dev/null | grep -E ':18789|:1878[0-9]'" || echo "")
PORT_LISTEN=$(echo "$PORT_LISTEN" | tr -d '\r')

DIAG_BLOB="state=${CONTAINER_STATE}; stability=${STAB_ID}; port18789=$( [ -n "$PORT_LISTEN" ] && echo listening || echo unknown ); logtail=${LOG_TAIL}"
# Strip any em dashes from diag.
DIAG_BLOB=$(printf '%s' "$DIAG_BLOB" | LC_ALL=C perl -pe 's/\xe2\x80\x94/-/g')

# ---- Idempotency check: if gateway is already OK, stop here. -----------------
CUR_G=$(probe_gateway)
if [ "$CUR_G" = "OK" ]; then
  CLASS="already-up"
  OUTCOME="FIXED"
  TTR="0"
  TRIED="(none, idempotent no-op)"
  ROOT_CAUSE="self-recovered between probe and remediation"
  PATTERN=$(pattern_flag "$CLASS")
  append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
  cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
  exit 0
fi

# ---- Step 2: classify -------------------------------------------------------

case "$CONTAINER_STATE" in
  *exited*|*dead*|*created*) CLASS="container-exited" ;;
esac
if [ "$CLASS" = "unknown" ]; then
  case "$LOG_TAIL" in
    *"agents.list"*|*"schema validation"*|*"AgentsConfigError"*|*"InvalidAgentsList"*) CLASS="config-invalid" ;;
  esac
fi
if [ "$CLASS" = "unknown" ] && [[ "$CONTAINER_STATE" == *"running"* ]] && [ -z "$PORT_LISTEN" ]; then
  # Container is up but gateway port isn't listening: most likely the
  # gateway proxy crashed inside an otherwise-healthy container. docker
  # restart fixes the common case.
  CLASS="gateway-port-closed"
fi
if [ "$CLASS" = "unknown" ]; then
  case "$LOG_TAIL" in
    *"401"*|*"403"*|*"token"*|*"auth"*|*"unauthorized"*) CLASS="gateway-auth" ;;
  esac
fi

# OOM marker upgrades classification.
case "$CONTAINER_STATE" in
  *"oomkilled=true"*) CLASS="container-exited"; ROOT_CAUSE="OOM kill, raise memory or reduce plugin load" ;;
esac

# ---- Step 3: remediate per class -------------------------------------------

PROJ_DIR=""
# Project folder convention: /docker/<short-id>/  where <short-id> derives from
# the container name "openclaw-XXXX-openclaw-1" -> openclaw-XXXX
PROJ_SHORT=$(echo "$CONTAINER" | sed 's/-openclaw-1$//')
PROJ_DIR="/docker/${PROJ_SHORT}"

START_EPOCH=$(date +%s)

case "$CLASS" in
  config-invalid)
    cmd1="docker exec -u node ${CONTAINER} openclaw doctor --fix"
    cmd2="docker restart ${CONTAINER}"
    [ "$DRY_RUN" = "1" ] || ssh_run 60 "$cmd1" >/dev/null 2>&1
    [ "$DRY_RUN" = "1" ] || ssh_run 30 "$cmd2" >/dev/null 2>&1
    TRIED="${cmd1}; ${cmd2}"
    ;;
  container-exited)
    cmd1="docker compose -f ${PROJ_DIR}/docker-compose.yml up -d --force-recreate"
    # Long mutating command: a force-recreate may re-pull a large image. Honor the
    # env-respecting inner wall so a legit rebuild is not SIGKILLed at the old 90s.
    [ "$DRY_RUN" = "1" ] || ssh_run "$REMEDIATE_TIMEOUT" "$cmd1" >/dev/null 2>&1
    TRIED="$cmd1"
    ;;
  gateway-port-closed)
    cmd1="docker restart ${CONTAINER}"
    [ "$DRY_RUN" = "1" ] || ssh_run 30 "$cmd1" >/dev/null 2>&1
    TRIED="$cmd1"
    ;;
  gateway-auth)
    TRIED="(none, surfaced for human, no auto-fix on auth class)"
    ROOT_CAUSE="auth/token failure, manual review required"
    PATTERN=$(pattern_flag "$CLASS")
    append_change_log "$CLASS" "UNFIXED" "0" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
    cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=UNFIXED
ttr_seconds=0
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
    exit 0
    ;;
  unknown|*)
    CLASS="unknown"
    TRIED="(none, surfaced for human review, no auto-fix on unknown class)"
    ROOT_CAUSE="failure class not in decision tree, manual review required"
    PATTERN=$(pattern_flag "$CLASS")
    append_change_log "$CLASS" "UNFIXED" "0" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
    cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=UNFIXED
ttr_seconds=0
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
    exit 0
    ;;
esac

# ---- Step 4: wait for recovery ----------------------------------------------

if [ "$DRY_RUN" = "1" ]; then
  OUTCOME="DRYRUN"; TTR="0"
  ROOT_CAUSE="DRY-RUN: planned ${CLASS}; no mutating command executed"
  PATTERN=$(pattern_flag "$CLASS")
  append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"
  cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=[DRY-RUN] ${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
  exit 0
fi

WAIT_RESULT=$(wait_for_gateway)
if [ "$WAIT_RESULT" = "TIMEOUT" ]; then
  OUTCOME="UNFIXED"
  TTR="${REMEDIATE_TIMEOUT}+"
  ROOT_CAUSE="${CLASS}, remediation chain did not restore gateway within ${REMEDIATE_TIMEOUT}s"
else
  OUTCOME="FIXED"
  TTR="$WAIT_RESULT"
  case "$CLASS" in
    config-invalid)       ROOT_CAUSE="agents.list / config schema invalid, repaired by doctor --fix" ;;
    container-exited)     [ -z "$ROOT_CAUSE" ] || [ "$ROOT_CAUSE" = "investigating" ] && ROOT_CAUSE="container down, restored via compose up --force-recreate" ;;
    gateway-port-closed)  ROOT_CAUSE="gateway port not listening, restored via docker restart" ;;
  esac
fi

PATTERN=$(pattern_flag "$CLASS")
append_change_log "$CLASS" "$OUTCOME" "$TTR" "$TRIED" "$DIAG_BLOB" "$PATTERN" "$ROOT_CAUSE"

cat <<EOF
===REMEDIATE-RESULT===
client=${CLIENT}
class=${CLASS}
outcome=${OUTCOME}
ttr_seconds=${TTR}
tried=${TRIED}
diag=${DIAG_BLOB}
pattern=${PATTERN}
root_cause=${ROOT_CAUSE}
===END===
EOF
