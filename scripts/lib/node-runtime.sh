#!/usr/bin/env bash
# node-runtime.sh: resolve THE node binary the Command Center runs on.
#
# ISSUE-09: the Command Center had no node runtime identity. Nothing in the
# repo named a node version, and every layer picked its own:
#
#   * ecosystem.config.cjs runs `script: 'bash'` with no interpreter and no
#     PATH, so pm2 hands the launcher whatever PATH pm2 itself inherited (on a
#     Mac, launchd's minimal PATH; after a `pm2 restart --update-env`, the
#     operator's interactive PATH).
#   * scripts/cc-start.sh exec'd a bare `node` off that ambient PATH.
#   * There was no .nvmrc, no .node-version, and `engines.node` accepted
#     ^20.19.0 || ^22.13.0 || >=24, so Node 26 satisfied every gate.
#   * `postinstall` runs `npm rebuild better-sqlite3`, which compiles against
#     whichever node ran npm.
#
# The result on client boxes: pm2 runs the app under node@24 (module ABI 137)
# while cron and update shells resolve Node 26 (ABI 147). An update rebuilds
# the native module for the shell's node, pm2 then loads it under its own, and
# better-sqlite3 throws NODE_MODULE_VERSION on every boot. That is a crash
# loop, and it recurs after every update because nothing pins the runtime.
#
# THE FLEET RUNTIME IS NODE 24. This script is the single place that decides,
# and every layer asks it: both ecosystem configs, cc-start.sh, atomic-deploy.sh
# and update.sh.
#
# RESOLUTION ORDER (first hit wins):
#   1. $CC_NODE_BIN            explicit operator override, honoured as given
#   2. /opt/homebrew/opt/node@24/bin/node    (Apple Silicon Homebrew)
#   3. /usr/local/opt/node@24/bin/node       (Intel Homebrew)
#   4. $NVM_DIR/versions/node/v24*/bin/node  (newest v24 nvm install)
#   5. `command -v node`, ONLY if its major version is 24
#
# Step 5 is the one that used to be implicit and unconditional. Making it last
# and conditional is the whole fix: an ambient node of the wrong major is no
# longer silently accepted as the runtime.
#
# Step 1 is an escape hatch and is NOT version-checked. An operator pinning a
# path has a reason, and cc-start.sh's ABI guard proves the choice against the
# artifact anyway, so a wrong override fails deterministically with a refusal
# receipt instead of being second-guessed here. A non-24 override does print a
# warning to stderr so it is never silent.
#
# CONTRACT:
#   stdout : the absolute path to the resolved node binary (nothing else)
#   exit 0 : resolved
#   exit 2 : no supported runtime; stderr carries a remedy line
#
# stdout stays clean because callers capture it directly. Every diagnostic goes
# to stderr.
#
# bash 3.2 safe on purpose: macOS still ships bash 3.2 and pm2 launches this
# through /bin/bash on some paths. No associative arrays, no `mapfile`, no `**`.
#
# Usage:
#   CC_NODE_BIN="$(bash scripts/lib/node-runtime.sh)" || exit 2
#   bash scripts/lib/node-runtime.sh --check     # human-readable summary
#   bash scripts/lib/node-runtime.sh --abi       # module ABI of the resolved node

set -uo pipefail

CC_NODE_REQUIRED_MAJOR="${CC_NODE_REQUIRED_MAJOR:-24}"

_ccnr_major() {  # _ccnr_major <node-binary> -> prints the major version, or nothing
  local bin="$1" ver
  [[ -n "$bin" && -x "$bin" ]] || return 1
  ver="$("$bin" --version 2>/dev/null)" || return 1
  # v24.8.0 -> 24. Anything that does not match is treated as unreadable.
  case "$ver" in
    v[0-9]*) printf '%s' "${ver#v}" | cut -d. -f1 ;;
    *) return 1 ;;
  esac
}

_ccnr_remedy() {
  printf '[node-runtime] FATAL: no Node %s runtime found for the Command Center.\n' "$CC_NODE_REQUIRED_MAJOR" >&2
  printf '[node-runtime] Looked at, in order:\n' >&2
  printf '[node-runtime]   1. $CC_NODE_BIN                          %s\n' "${CC_NODE_BIN:-<unset>}" >&2
  printf '[node-runtime]   2. /opt/homebrew/opt/node@%s/bin/node     %s\n' \
    "$CC_NODE_REQUIRED_MAJOR" "$([[ -x "/opt/homebrew/opt/node@${CC_NODE_REQUIRED_MAJOR}/bin/node" ]] && echo present || echo absent)" >&2
  printf '[node-runtime]   3. /usr/local/opt/node@%s/bin/node        %s\n' \
    "$CC_NODE_REQUIRED_MAJOR" "$([[ -x "/usr/local/opt/node@${CC_NODE_REQUIRED_MAJOR}/bin/node" ]] && echo present || echo absent)" >&2
  printf '[node-runtime]   4. $NVM_DIR/versions/node/v%s*/bin/node   (NVM_DIR=%s)\n' \
    "$CC_NODE_REQUIRED_MAJOR" "${NVM_DIR:-$HOME/.nvm}" >&2
  printf '[node-runtime]   5. node on PATH                          %s\n' \
    "$(command -v node 2>/dev/null || echo '<not on PATH>')$(command -v node >/dev/null 2>&1 && printf ' (v%s)' "$(node --version 2>/dev/null | tr -d v)")" >&2
  printf '[node-runtime] REMEDY: install the fleet runtime, then retry.\n' >&2
  printf '[node-runtime]   macOS:  brew install node@%s\n' "$CC_NODE_REQUIRED_MAJOR" >&2
  printf '[node-runtime]   nvm:    nvm install %s\n' "$CC_NODE_REQUIRED_MAJOR" >&2
  printf '[node-runtime]   Or pin one explicitly: export CC_NODE_BIN=/path/to/node\n' >&2
}

# Resolve. Prints the path on success, prints nothing and returns 1 on failure.
_ccnr_resolve() {
  local candidate major

  # 1. Explicit operator override. Honoured as given; warned about if it is not
  #    the fleet major, never rejected here (cc-start.sh proves it against the
  #    artifact's recorded ABI, which is the check that actually matters).
  if [[ -n "${CC_NODE_BIN:-}" ]]; then
    if [[ ! -x "$CC_NODE_BIN" ]]; then
      printf '[node-runtime] CC_NODE_BIN is set to "%s" but that is not an executable file.\n' "$CC_NODE_BIN" >&2
      return 1
    fi
    major="$(_ccnr_major "$CC_NODE_BIN")" || major=""
    if [[ -n "$major" && "$major" != "$CC_NODE_REQUIRED_MAJOR" ]]; then
      printf '[node-runtime] WARNING: CC_NODE_BIN pins Node %s, but the fleet runtime is Node %s.\n' \
        "$major" "$CC_NODE_REQUIRED_MAJOR" >&2
      printf '[node-runtime] Honouring the explicit override. The ABI guard in cc-start.sh still applies.\n' >&2
    fi
    printf '%s\n' "$CC_NODE_BIN"
    return 0
  fi

  # 2/3. Homebrew keg-only installs, Apple Silicon then Intel.
  for candidate in \
    "/opt/homebrew/opt/node@${CC_NODE_REQUIRED_MAJOR}/bin/node" \
    "/usr/local/opt/node@${CC_NODE_REQUIRED_MAJOR}/bin/node"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # 4. nvm. Newest v24.* wins; `sort -V` is not available everywhere, so the
  #    glob is sorted with plain `sort -r` over the version directory names,
  #    which is correct for the v24.x.y shapes nvm creates.
  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  if [[ -d "$nvm_root/versions/node" ]]; then
    # No `mapfile` (bash 3.2). One candidate per line, newest first.
    local nvm_dir
    for nvm_dir in $(ls -1 "$nvm_root/versions/node" 2>/dev/null | grep "^v${CC_NODE_REQUIRED_MAJOR}\." | sort -r); do
      candidate="$nvm_root/versions/node/$nvm_dir/bin/node"
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi

  # 5. PATH, but ONLY at the required major. This is the step that used to be
  #    unconditional, and the reason a box could run the app on Node 26.
  candidate="$(command -v node 2>/dev/null)" || candidate=""
  if [[ -n "$candidate" ]]; then
    major="$(_ccnr_major "$candidate")" || major=""
    if [[ "$major" == "$CC_NODE_REQUIRED_MAJOR" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

CCNR_MODE="${1:---path}"

case "$CCNR_MODE" in
  --path|"")
    RESOLVED="$(_ccnr_resolve)" || { _ccnr_remedy; exit 2; }
    printf '%s\n' "$RESOLVED"
    ;;
  --abi)
    RESOLVED="$(_ccnr_resolve)" || { _ccnr_remedy; exit 2; }
    "$RESOLVED" -p process.versions.modules 2>/dev/null || {
      printf '[node-runtime] FATAL: %s could not report process.versions.modules.\n' "$RESOLVED" >&2
      exit 2
    }
    ;;
  --check)
    RESOLVED="$(_ccnr_resolve)" || { _ccnr_remedy; exit 2; }
    printf 'node binary : %s\n' "$RESOLVED"
    printf 'version     : %s\n' "$("$RESOLVED" --version 2>/dev/null || echo unknown)"
    printf 'module ABI  : %s\n' "$("$RESOLVED" -p process.versions.modules 2>/dev/null || echo unknown)"
    ;;
  *)
    printf 'usage: node-runtime.sh [--path | --abi | --check]\n' >&2
    exit 64
    ;;
esac
