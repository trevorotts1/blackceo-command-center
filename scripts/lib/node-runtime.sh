#!/usr/bin/env bash
# node-runtime.sh: resolve THE ONE node binary this Command Center uses.
#
# ISSUE-09. The defect is NOT a version number. It is DRIFT between the node
# that BUILDS and REBUILDS the native modules and the node that RUNS the
# server:
#
#   * ecosystem.config.cjs ran `script: 'bash'` with no interpreter and no
#     PATH, so pm2 handed the launcher whatever PATH pm2 itself inherited (on a
#     Mac, launchd's minimal PATH; after a `pm2 restart --update-env`, the
#     operator's interactive PATH).
#   * scripts/cc-start.sh exec'd a bare `node` off that ambient PATH.
#   * `postinstall` runs `npm rebuild better-sqlite3`, compiling against
#     whichever node ran npm, which on a cron/update shell is a different node
#     again.
#
# better-sqlite3 then throws NODE_MODULE_VERSION on every boot, and it recurs
# after every update because nothing pinned the IDENTITY of the runtime.
#
# WHY THIS IS NOT A VERSION PIN. An earlier revision of this file required
# Node 24 and set `engines.node` to `>=24 <25`. Measured against the live
# fleet, that would have refused Command Center updates on most boxes: two
# client machines and the operator Mac all run v26.7.0 or v26.8.1 with no
# node@24 present at all, and one VPS container runs v26.7.0 while its own pm2
# process reports 25.6.1. Only one client Mac and the Contabo containers carry
# a 24. A rule that locks the majority of the fleet out of updating does not
# fix ABI drift; it replaces one outage with another.
#
# So the rule is CONSISTENCY, not a version: whatever node this resolver
# returns is the node used for `npm ci`, `npm rebuild better-sqlite3`,
# `next build`, the deploy's native gate, and cc-start's exec. Its absolute
# path and its module ABI are recorded in the build manifest, so the NEXT
# update reuses the same binary and the artifact can be checked against the
# runtime before the server starts.
#
# RESOLUTION ORDER (first hit wins):
#   1. $CC_NODE_BIN                      explicit operator override
#   2. .next/build-inventory.json node_bin   the node that built the artifact
#                                        being served, when it still exists
#   3. the running CC pm2 process's node the binary the live server is on
#   4. known pins (/opt/homebrew/opt/node@24/bin/node and friends)
#   5. `command -v node`                 whatever PATH has
#
# Steps 2 and 3 are the continuity steps and the heart of the fix. A box that
# built its artifact with a particular node keeps using that node, so a
# rebuild cannot produce a binary the server then fails to load. Step 3 covers
# the first update after this lands, when the artifact predates the manifest
# field but the live process still knows its own interpreter.
#
# Step 5 is last, not absent. It carries no version test: judging the SUPPORTED
# range is update.sh's job (_cc_require_supported_node, against package.json
# engines), and it applies to whatever THIS resolver returns. Identity is
# decided here; supportedness is decided there. Keeping those separate is what
# lets a Node 26 box stay on Node 26, consistently, and still be gated against
# the declared range.
#
# CONTRACT:
#   stdout : the absolute path to the resolved node binary (nothing else)
#   exit 0 : resolved
#   exit 2 : no node found anywhere; stderr carries a remedy line
#
# stdout stays clean because callers capture it directly. Every diagnostic goes
# to stderr, including which step won.
#
# bash 3.2 safe on purpose: macOS still ships bash 3.2 and pm2 launches this
# through /bin/bash on some paths. No associative arrays, no `mapfile`, no `**`.
#
# Usage:
#   CC_NODE_BIN="$(bash scripts/lib/node-runtime.sh)" || exit 2
#   bash scripts/lib/node-runtime.sh --check     # human-readable summary
#   bash scripts/lib/node-runtime.sh --abi       # module ABI of the resolved node
#   bash scripts/lib/node-runtime.sh --why       # the path plus the step that won
#
# CC_APP_DIR overrides the app directory used for steps 2 and 3 (default: the
# checkout this script lives in).

set -uo pipefail

CCNR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCNR_APP_DIR="${CC_APP_DIR:-$(cd "$CCNR_SCRIPT_DIR/../.." && pwd)}"
# The known pins, tried in order at step 4. Space separated (bash 3.2: no arrays
# needed for a list this small, and word splitting is the point).
CCNR_KNOWN_PINS="${CCNR_KNOWN_PINS:-/opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node}"
# The pm2 app names that can be THIS Command Center. Never widened at runtime:
# reading a node path out of an unrelated pm2 app would be worse than falling
# through to PATH.
CCNR_CC_APP_NAMES="${CCNR_CC_APP_NAMES:-blackceo-command-center cc-prod command-center mission-control}"

# The step that produced the answer, for --why and the stderr note.
CCNR_SOURCE=""

_ccnr_is_usable() {  # _ccnr_is_usable <path> -> 0 when it is an executable node
  local bin="${1:-}"
  [[ -n "$bin" && -x "$bin" ]] || return 1
  "$bin" -p process.versions.modules >/dev/null 2>&1 || return 1
  return 0
}

# ── step 2: the node recorded in the served artifact's manifest ──────────────
_ccnr_from_manifest() {
  local manifest="$CCNR_APP_DIR/.next/build-inventory.json" recorded
  [[ -f "$manifest" ]] || return 1
  recorded="$(sed -n 's/.*"node_bin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -1 || true)"
  [[ -n "$recorded" && "$recorded" != "unknown" ]] || return 1
  _ccnr_is_usable "$recorded" || return 1
  printf '%s' "$recorded"
}

# ── step 3: the node the live CC pm2 process is running on ──────────────────
# Preferred field is the process's own CC_NODE_BIN (this repo's ecosystem
# configs export it). Falls back to pm2_env.exec_interpreter when that is a
# real absolute path rather than the literal "node"/"none" pm2 uses by default.
_ccnr_from_pm2() {
  command -v pm2 >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local found
  found="$(pm2 jlist 2>/dev/null | python3 -s -c '
import json, sys
names = set(sys.argv[1].split())
try:
    apps = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(apps, list):
    sys.exit(1)
for app in apps:
    if not isinstance(app, dict):
        continue
    if app.get("name") not in names:
        continue
    env = (app.get("pm2_env") or {})
    # The explicit contract first: the ecosystem configs export CC_NODE_BIN.
    candidate = (env.get("env") or {}).get("CC_NODE_BIN") or env.get("CC_NODE_BIN")
    if isinstance(candidate, str) and candidate.startswith("/"):
        print(candidate)
        sys.exit(0)
    # Fall back to the interpreter, but only when it is a real path. pm2 writes
    # "node" or "none" by default, which names nothing.
    interp = env.get("exec_interpreter")
    if isinstance(interp, str) and interp.startswith("/") and "node" in interp:
        print(interp)
        sys.exit(0)
sys.exit(1)
' "$CCNR_CC_APP_NAMES" 2>/dev/null)" || return 1
  [[ -n "$found" ]] || return 1
  _ccnr_is_usable "$found" || return 1
  printf '%s' "$found"
}

_ccnr_remedy() {
  printf '[node-runtime] FATAL: no usable node binary found for the Command Center.\n' >&2
  printf '[node-runtime] Looked at, in order:\n' >&2
  printf '[node-runtime]   1. $CC_NODE_BIN                       %s\n' "${CC_NODE_BIN:-<unset>}" >&2
  printf '[node-runtime]   2. %s/.next/build-inventory.json node_bin   %s\n' \
    "$CCNR_APP_DIR" "$([[ -f "$CCNR_APP_DIR/.next/build-inventory.json" ]] && echo 'manifest present, no usable node_bin' || echo 'no manifest')" >&2
  printf '[node-runtime]   3. running CC pm2 process             %s\n' \
    "$(command -v pm2 >/dev/null 2>&1 && echo 'pm2 present, no usable node recorded' || echo 'pm2 not on PATH')" >&2
  printf '[node-runtime]   4. known pins                         %s\n' "$CCNR_KNOWN_PINS" >&2
  printf '[node-runtime]   5. node on PATH                       %s\n' \
    "$(command -v node 2>/dev/null || echo '<not on PATH>')" >&2
  printf '[node-runtime] REMEDY: install Node, or pin one explicitly:\n' >&2
  printf '[node-runtime]   export CC_NODE_BIN=/absolute/path/to/node\n' >&2
  printf '[node-runtime] The supported version RANGE is enforced separately, by\n' >&2
  printf '[node-runtime] update.sh against package.json engines, on whatever this resolves.\n' >&2
}

# Prints the path on success and sets CCNR_SOURCE; returns 1 on failure.
_ccnr_resolve() {
  local candidate

  # 1. Explicit operator override. Honoured as given.
  if [[ -n "${CC_NODE_BIN:-}" ]]; then
    if ! _ccnr_is_usable "$CC_NODE_BIN"; then
      printf '[node-runtime] CC_NODE_BIN is set to "%s" but it is not an executable node.\n' "$CC_NODE_BIN" >&2
      return 1
    fi
    CCNR_SOURCE="CC_NODE_BIN override"
    printf '%s\n' "$CC_NODE_BIN"
    return 0
  fi

  # 2. The node that built the artifact currently being served. This is the
  #    continuity step: rebuild with the same binary that produced what is on
  #    disk, and the ABI cannot drift out from under the server.
  candidate="$(_ccnr_from_manifest)" && {
    CCNR_SOURCE="build-inventory.json node_bin (the node that built the served artifact)"
    printf '%s\n' "$candidate"
    return 0
  }

  # 3. The node the live CC process is running on. Covers the first update
  #    after this lands, when the served artifact predates the node_bin field
  #    but the running process still knows its own interpreter.
  candidate="$(_ccnr_from_pm2)" && {
    CCNR_SOURCE="the running Command Center pm2 process"
    printf '%s\n' "$candidate"
    return 0
  }

  # 4. Known pins.
  for candidate in $CCNR_KNOWN_PINS; do
    if _ccnr_is_usable "$candidate"; then
      CCNR_SOURCE="known pin $candidate"
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  # 5. PATH. No version test here on purpose: identity is this script's job,
  #    and the supported range is checked by update.sh on whatever comes back.
  candidate="$(command -v node 2>/dev/null)" || candidate=""
  if _ccnr_is_usable "$candidate"; then
    CCNR_SOURCE="node on PATH"
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

CCNR_MODE="${1:---path}"

case "$CCNR_MODE" in
  --path|"")
    RESOLVED="$(_ccnr_resolve)" || { _ccnr_remedy; exit 2; }
    printf '%s\n' "$RESOLVED"
    ;;
  --why)
    RESOLVED="$(_ccnr_resolve)" || { _ccnr_remedy; exit 2; }
    # CCNR_SOURCE is set inside the subshell of the command substitution above,
    # so re-resolve in THIS shell to read it back (bash 3.2 has no other way).
    _ccnr_resolve >/dev/null
    printf '%s\t%s\n' "$RESOLVED" "$CCNR_SOURCE"
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
    _ccnr_resolve >/dev/null
    printf 'node binary : %s\n' "$RESOLVED"
    printf 'resolved by : %s\n' "$CCNR_SOURCE"
    printf 'version     : %s\n' "$("$RESOLVED" --version 2>/dev/null || echo unknown)"
    printf 'module ABI  : %s\n' "$("$RESOLVED" -p process.versions.modules 2>/dev/null || echo unknown)"
    printf 'app dir     : %s\n' "$CCNR_APP_DIR"
    ;;
  *)
    printf 'usage: node-runtime.sh [--path | --why | --abi | --check]\n' >&2
    exit 64
    ;;
esac
