#!/usr/bin/env bash
# scripts/lib/pm2-logrotate.sh — sourced helper: keep pm2's logs from eating the box.
#
# WHY THIS EXISTS
# ---------------
# pm2 appends to ~/.pm2/logs/*.log forever. Nothing in this repo ever rotated
# them, and the self-checking work that added this helper was prompted by a
# measured case of the opposite failure: a scheduler line written every 2
# minutes filled the pm2 error log. An unbounded log is a disk-full incident
# waiting on a long-running box, and disk-full takes the whole command center
# down — the class the deploy's own 5 GB disk gate exists to prevent.
#
# pm2-logrotate is pm2's own module for this. This helper installs it if it is
# missing and pins its settings, and it is CAREFUL about churn: a value is only
# written when the current value actually differs, so a box that is already
# correct produces zero writes and zero log noise on every deploy.
#
# CONTRACT: this NEVER fails the caller. Every failure path (pm2 absent, npm
# offline, a module registry that will not answer) warns and returns 0. Log
# rotation is hygiene; it is never a reason to fail an otherwise-green deploy.
#
# USAGE:  source "${SCRIPT_DIR}/lib/pm2-logrotate.sh"; oc_ensure_pm2_logrotate

# Desired settings. Roughly 20 MB x 14 files per app worst case, compressed,
# rotated at midnight, with the worker checking every 5 minutes.
OC_PM2_LOGROTATE_MAX_SIZE="${OC_PM2_LOGROTATE_MAX_SIZE:-20M}"
OC_PM2_LOGROTATE_RETAIN="${OC_PM2_LOGROTATE_RETAIN:-14}"
OC_PM2_LOGROTATE_COMPRESS="${OC_PM2_LOGROTATE_COMPRESS:-true}"
OC_PM2_LOGROTATE_INTERVAL="${OC_PM2_LOGROTATE_INTERVAL:-0 0 * * *}"
OC_PM2_LOGROTATE_WORKER="${OC_PM2_LOGROTATE_WORKER:-300}"

_oc_lr_log()  { printf '[pm2-logrotate] %s\n' "$*" >&2; }
_oc_lr_warn() { printf '[pm2-logrotate WARN] %s\n' "$*" >&2; }

# The current value of one pm2-logrotate key, or '' when unset/unreadable.
# Tolerates both shapes pm2 has printed over the years:
#   $ pm2 set pm2-logrotate:max_size 10M
#   pm2-logrotate:max_size = '10M'
# The value may contain spaces (rotateInterval is a cron expression), so this
# takes everything after the key rather than the last field.
_oc_pm2_logrotate_value() {  # _oc_pm2_logrotate_value CONF_TEXT KEY
  local conf="$1" key="$2" line
  line="$(printf '%s\n' "$conf" | grep -E "pm2-logrotate:${key}([[:space:]]|=)" | head -1)"
  [[ -z "$line" ]] && { printf ''; return 0; }
  line="${line#*pm2-logrotate:"${key}"}"
  line="${line#*=}"
  # trim surrounding whitespace, then surrounding quotes, then whitespace again
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
  line="${line#\'}"; line="${line%\'}"; line="${line#\"}"; line="${line%\"}"
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
  printf '%s' "$line"
}

oc_ensure_pm2_logrotate() {
  if ! command -v pm2 >/dev/null 2>&1; then
    _oc_lr_warn "pm2 is not on PATH — skipping log rotation setup."
    return 0
  fi

  local listing
  listing="$(pm2 ls 2>/dev/null)"
  if ! printf '%s\n' "$listing" | grep -q 'pm2-logrotate'; then
    _oc_lr_log "pm2-logrotate is not installed — installing it."
    if pm2 install pm2-logrotate >/dev/null 2>&1; then
      _oc_lr_log "installed pm2-logrotate."
    else
      _oc_lr_warn "could not install pm2-logrotate (offline npm or a module registry that would not answer). pm2 logs will NOT be rotated on this box; install it by hand with: pm2 install pm2-logrotate"
      return 0
    fi
  fi

  local conf
  conf="$(pm2 conf pm2-logrotate 2>/dev/null)"

  _oc_pm2_logrotate_pin() {  # _oc_pm2_logrotate_pin KEY DESIRED
    local key="$1" desired="$2" current
    current="$(_oc_pm2_logrotate_value "$conf" "$key")"
    if [[ "$current" == "$desired" ]]; then
      return 0
    fi
    if pm2 set "pm2-logrotate:${key}" "$desired" >/dev/null 2>&1; then
      _oc_lr_log "set ${key} = ${desired}${current:+ (was ${current})}"
    else
      _oc_lr_warn "could not set ${key} — leaving it at '${current:-unset}'."
    fi
    return 0
  }

  _oc_pm2_logrotate_pin max_size       "$OC_PM2_LOGROTATE_MAX_SIZE"
  _oc_pm2_logrotate_pin retain         "$OC_PM2_LOGROTATE_RETAIN"
  _oc_pm2_logrotate_pin compress       "$OC_PM2_LOGROTATE_COMPRESS"
  _oc_pm2_logrotate_pin rotateInterval "$OC_PM2_LOGROTATE_INTERVAL"
  _oc_pm2_logrotate_pin workerInterval "$OC_PM2_LOGROTATE_WORKER"

  unset -f _oc_pm2_logrotate_pin
  return 0
}
