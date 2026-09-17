#!/usr/bin/env bash
# rescue-credentials.sh — non-evaluating Rescue Rangers credential loader.
#
# Bash 3.2 compatible on purpose: cc-start.sh may be launched with /bin/bash
# on macOS. The parser below deliberately does not use eval, source the secret
# file, or expand values. It reads only the allowlisted key named by the
# caller and returns it through a shell variable.
#
# Public functions:
#   rescue_service_home      -> sets RESCUE_SERVICE_HOME from the passwd entry
#                               for the current effective service identity
#   rescue_secret_store_path -> sets RESCUE_SECRET_STORE_PATH from the
#                               configured service root or service identity
#   rescue_read_dotenv_key   -> sets RESCUE_DOTENV_VALUE for one allowlisted key
#   rescue_load_webhook_secret -> honors process env first, then the store
#
# Return codes for rescue_load_webhook_secret:
#   0 secret already present in env or loaded from the store
#   1 store/key unavailable
#   2 key exists in the store but is empty

# Trim ASCII/Unicode shell whitespace from both ends without invoking sed.
_rescue_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  RESCUE_TRIMMED="$value"
}

# Parse one dotenv assignment value. Quoted comments are supported after the
# closing quote; unquoted comments are supported when '#' follows whitespace.
# Escaped quotes and backslashes are preserved as literal characters except
# that \" and \\ are unescaped inside double quotes.
_rescue_parse_dotenv_value() {
  local raw="$1"
  local value=""
  local quote=""
  local index=0
  local length="${#raw}"
  local char=""
  local next=""
  local rest=""

  RESCUE_DOTENV_VALUE=""
  _rescue_trim "$raw"
  raw="$RESCUE_TRIMMED"
  length="${#raw}"
  [[ "$length" -gt 0 ]] || return 0

  char="${raw:0:1}"
  if [[ "$char" == '"' || "$char" == "'" ]]; then
    quote="$char"
    index=1
    while [[ "$index" -lt "$length" ]]; do
      char="${raw:index:1}"
      if [[ "$quote" == '"' && "$char" == '\' && "$index" -lt "$((length - 1))" ]]; then
        next="${raw:index+1:1}"
        if [[ "$next" == '"' || "$next" == '\' ]]; then
          value+="$next"
        else
          value+="$char$next"
        fi
        index=$((index + 2))
        continue
      fi
      if [[ "$char" == "$quote" ]]; then
        rest="${raw:index+1}"
        _rescue_trim "$rest"
        if [[ -z "$RESCUE_TRIMMED" || "$RESCUE_TRIMMED" == \#* ]]; then
          RESCUE_DOTENV_VALUE="$value"
          return 0
        fi
        return 1
      fi
      value+="$char"
      index=$((index + 1))
    done
    return 1
  fi

  if [[ "$raw" == \#* ]]; then
    return 0
  fi

  local previous=""
  index=0
  while [[ "$index" -lt "$length" ]]; do
    char="${raw:index:1}"
    if [[ "$char" == '#' && ( "$previous" == ' ' || "$previous" == "$TAB" ) ]]; then
      break
    fi
    value+="$char"
    previous="$char"
    index=$((index + 1))
  done

  _rescue_trim "$value"
  RESCUE_DOTENV_VALUE="$RESCUE_TRIMMED"
  return 0
}

# Read exactly one key from a dotenv file. The value never crosses stdout.
# The last valid assignment wins, matching the prior tail -1 behavior.
rescue_read_dotenv_key() {
  local wanted_key="$1"
  local file="$2"
  local raw=""
  local line=""
  local key=""
  local value_part=""
  local found=0

  RESCUE_DOTENV_VALUE=""
  [[ -n "$wanted_key" && -n "$file" && -f "$file" && -r "$file" ]] || return 1

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    _rescue_trim "$raw"
    line="$RESCUE_TRIMMED"
    [[ -n "$line" && "$line" != \#* ]] || continue
    if [[ "$line" == "export " ]]; then
      continue
    fi
    if [[ "$line" == "export "* ]]; then
      line="${line#export }"
      _rescue_trim "$line"
      line="$RESCUE_TRIMMED"
    fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    _rescue_trim "$key"
    key="$RESCUE_TRIMMED"
    [[ "$key" == "$wanted_key" ]] || continue
    value_part="${line#*=}"
    _rescue_parse_dotenv_value "$value_part" || return 1
    RESCUE_DOTENV_VALUE="$RESCUE_DOTENV_VALUE"
    found=1
  done < "$file"

  [[ "$found" -eq 1 ]]
}

# Resolve the passwd home for the current effective service identity. This is
# intentionally independent of inherited HOME, which PM2/systemd/cron can set
# to an operator or container path rather than the service account's home.
rescue_service_home() {
  local uid=""
  local user=""
  local record=""
  local service_home=""

  RESCUE_SERVICE_HOME=""
  uid="$(id -u 2>/dev/null)" || return 1

  if command -v getent >/dev/null 2>&1; then
    record="$(getent passwd "$uid" 2>/dev/null)" || return 1
    IFS=':' read -r _ _ _ _ _ service_home _ <<< "$record"
    [[ -n "$service_home" ]] || return 1
    RESCUE_SERVICE_HOME="$service_home"
    return 0
  fi

  if command -v dscl >/dev/null 2>&1; then
    user="$(id -un 2>/dev/null)" || return 1
    record="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null)" || return 1
    service_home="${record#NFSHomeDirectory: }"
    _rescue_trim "$service_home"
    [[ -n "$RESCUE_TRIMMED" ]] || return 1
    RESCUE_SERVICE_HOME="$RESCUE_TRIMMED"
    return 0
  fi

  return 1
}

# Resolve the configured store, without deriving it from inherited HOME.
# OPENCLAW_ROOT is the explicit service runtime root. On the Docker platform,
# /data/.openclaw is the persistent service root. Otherwise the current
# service identity's passwd home provides the Mac fallback.
rescue_secret_store_path() {
  local root=""

  RESCUE_SECRET_STORE_PATH=""
  if [[ -n "${OPENCLAW_ROOT:-}" ]]; then
    [[ "$OPENCLAW_ROOT" == /* ]] || return 1
    root="${OPENCLAW_ROOT%/}"
    RESCUE_SECRET_STORE_PATH="$root/secrets/.env"
    return 0
  fi

  if [[ -d "/data/.openclaw" ]]; then
    RESCUE_SECRET_STORE_PATH="/data/.openclaw/secrets/.env"
    return 0
  fi

  rescue_service_home || return 1
  RESCUE_SECRET_STORE_PATH="$RESCUE_SERVICE_HOME/.openclaw/secrets/.env"
  return 0
}

# Load only the Rescue webhook secret. Process environment wins; the store is
# consulted only when the environment has no value. An empty file value is
# returned as status 2 so the caller can report it without exporting an empty
# secret.
rescue_load_webhook_secret() {
  if [[ -n "${RESCUE_RANGERS_WEBHOOK_SECRET:-}" ]]; then
    return 0
  fi

  rescue_secret_store_path || return 1
  rescue_read_dotenv_key "RESCUE_RANGERS_WEBHOOK_SECRET" "$RESCUE_SECRET_STORE_PATH" || return 1
  if [[ -z "$RESCUE_DOTENV_VALUE" ]]; then
    return 2
  fi
  export RESCUE_RANGERS_WEBHOOK_SECRET="$RESCUE_DOTENV_VALUE"
  return 0
}

# Use a literal tab variable because Bash 3.2 pattern matching is clearer with
# a named value than an embedded ANSI-C quote in the comparison.
TAB=$'\t'
