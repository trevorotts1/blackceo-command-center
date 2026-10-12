#!/usr/bin/env bash
#
# cc-start-sqlite-module-guard.test.sh  (CCG-1)
#
# THE DEFECT: cc-start.sh's ABI guard compared the web-app build's node ABI with
# the runtime but never loaded the compiled better-sqlite3 module. An `npm
# rebuild` under another node (global node 26, ABI 147) left a module the server's
# node (24/25, ABI 137/141) cannot load; the guard said "artifact and runtime
# agree", the app started with a dead database ("FATAL: DB init failed").
#
# Runs the REAL scripts/cc-start.sh in a throwaway app dir with a fake
# better-sqlite3 that throws the real NODE_MODULE_VERSION message until a
# `.good` marker exists, and a fake npm that creates the marker (or not).
# Set CC_START_SCRIPT to run an older launcher (the "before" run).
#
#   G0  control: the module loads -> launches, npm never called
#   G1  NODE_MODULE_VERSION mismatch + working rebuild -> launches, rebuilt once,
#       with the npm and node of the PINNED runtime (not the PATH decoy)
#   G2  mismatch + rebuild that does not fix it -> exit 78, durable
#       native-module-load-failed receipt, nothing launched
#   G3  a non-ABI load error -> exit 78, no rebuild attempted
#   G4  no node_modules/better-sqlite3 at all -> skipped, launches
#   R1  repair-command-center.sh rebuilds with the resolved runtime, not PATH's node
#
# Run: bash tests/unit/cc-start-sqlite-module-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CC_START="${CC_START_SCRIPT:-$REPO_ROOT/scripts/cc-start.sh}"
REAL_NODE="$(command -v node)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-sqlite-guard.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/pinned" "$WORK/decoy" "$WORK/markers"

# The pinned runtime: a wrapper that reports a fixed ABI and runs the real node
# for -e. Its directory also holds the npm that must be used for the rebuild.
cat > "$WORK/pinned/node" <<WRAP
#!/usr/bin/env bash
case "\${1:-}" in
  --version) printf 'v24.0.0\n' ;;
  -p) [[ "\${2:-}" == "process.versions.modules" ]] && printf '137\n' || printf '\n' ;;
  -e) exec "$REAL_NODE" "\$@" ;;
  *) printf '%s\n' "\$*" > "\${NODE_MARKER_FILE:-/dev/null}" ;;
esac
WRAP
# fake npm: logs who it is, then "rebuilds" (creates .good) when FAKE_NPM_FIX=1.
fake_npm() {  # fake_npm <path> <label>
  cat > "$1" <<NPM
#!/usr/bin/env bash
printf '%s|%s|%s\n' "$2" "\$*" "\$(dirname "\$(command -v node 2>/dev/null)")" >> "\$NPM_LOG"
[[ "\${FAKE_NPM_FIX:-0}" == "1" && "\${1:-}" == "rebuild" ]] && touch node_modules/better-sqlite3/.good
exit 0
NPM
  chmod +x "$1"
}
fake_npm "$WORK/pinned/npm" pinned-npm
fake_npm "$WORK/decoy/npm" DECOY-npm
chmod +x "$WORK/pinned/node"
for c in lsof fuser python3; do printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/decoy/$c"; chmod +x "$WORK/decoy/$c"; done

# make_app <name> <module-kind: abi|other|none|good>
make_app() {
  local app="$WORK/apps/$1"
  mkdir -p "$app/scripts/lib" "$app/src" "$app/public" "$app/.next" "$app/.cc-state"
  cp "$CC_START" "$app/scripts/cc-start.sh"
  cp "$REPO_ROOT/scripts/lib/rescue-credentials.sh" "$REPO_ROOT/scripts/lib/build-inventory.sh" "$app/scripts/lib/"
  printf '// fixture\n' > "$app/scripts/next-service-env.cjs"
  printf '{"name":"f","version":"1.0.0","private":true}\n' > "$app/package.json"
  printf '{"name":"f","version":"1.0.0","lockfileVersion":3}\n' > "$app/package-lock.json"
  printf 'export const a = 1;\n' > "$app/src/a.ts"
  printf 'x\n' > "$app/public/.keep"
  printf 'fixture-build-id\n' > "$app/.next/BUILD_ID"
  CC_NODE_BIN="$WORK/pinned/node" bash "$app/scripts/lib/build-inventory.sh" \
    --manifest "$app" "$app/.next" "fixture-build-id" "$(date +%s)" >/dev/null
  local m="$app/node_modules/better-sqlite3"
  case "$2" in
    none) ;;
    good) mkdir -p "$m"; touch "$m/.good" ;;
    abi|other) mkdir -p "$m" ;;
  esac
  if [[ "$2" != "none" ]]; then
    if [[ "$2" == "other" ]]; then
      printf 'throw new Error("SQLITE_CANTOPEN: unable to open database file");\n' > "$m/index.js"
    else
      cat > "$m/index.js" <<'JS'
const fs = require('fs'), path = require('path');
if (!fs.existsSync(path.join(__dirname, '.good'))) {
  const e = new Error('The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 137. Please try re-compiling or re-installing');
  e.code = 'ERR_DLOPEN_FAILED';
  throw e;
}
module.exports = function Database() { return { close() {} }; };
JS
    fi
  fi
  printf '%s' "$app"
}

# run_case <name> <app> <expect-exit> <expect-launch> <fix 0|1>
run_case() {
  local name="$1" app="$2" want_rc="$3" want_launch="$4" fix="$5"
  local marker="$WORK/markers/$name" rc
  : > "$WORK/npm-$name.log"
  (
    cd "$app" || exit 99
    export PATH="$WORK/decoy:/usr/bin:/bin"
    export CC_NODE_BIN="$WORK/pinned/node" CC_PORT=43210 CC_PORT_OVERRIDE_ACK=1 NODE_ENV=production
    export NODE_MARKER_FILE="$marker" NPM_LOG="$WORK/npm-$name.log" FAKE_NPM_FIX="$fix"
    export RESCUE_RANGERS_WEBHOOK_SECRET=fixture-secret
    bash "$app/scripts/cc-start.sh"
  ) >"$WORK/out-$name.txt" 2>&1
  rc=$?
  [[ $rc -eq $want_rc ]] && ok "$name: exit $rc" || bad "$name: expected exit $want_rc, got $rc"
  if [[ "$want_launch" == "yes" ]]; then
    [[ -f "$marker" ]] && ok "$name: server launched" || bad "$name: server was NOT launched"
  else
    [[ ! -f "$marker" ]] && ok "$name: server not launched" || bad "$name: server launched on a dead database"
  fi
}
npm_calls() { grep -c . "$WORK/npm-$1.log" 2>/dev/null || true; }

echo "[G0] control: module loads"
A="$(make_app g0 good)"; run_case g0 "$A" 0 yes 0
[[ "$(npm_calls g0)" == 0 ]] && ok "G0: no rebuild when nothing is wrong" || bad "G0: npm was called"

echo "[G1] NODE_MODULE_VERSION mismatch, rebuild repairs it"
A="$(make_app g1 abi)"; run_case g1 "$A" 0 yes 1
[[ "$(npm_calls g1)" == 1 ]] && ok "G1: exactly one rebuild" || bad "G1: npm called $(npm_calls g1) times"
grep -q '^pinned-npm|rebuild better-sqlite3' "$WORK/npm-g1.log" \
  && ok "G1: rebuilt with the pinned runtime's npm (not the PATH decoy)" || bad "G1: npm used: $(cat "$WORK/npm-g1.log")"
grep -q "|$WORK/pinned\$" "$WORK/npm-g1.log" \
  && ok "G1: npm saw the pinned node first on PATH" || bad "G1: node on PATH during rebuild: $(cat "$WORK/npm-g1.log")"
[[ -e "$A/node_modules/better-sqlite3/.good" ]] && ok "G1: module is repaired on disk" || bad "G1: module still broken"

echo "[G2] mismatch, rebuild does not repair it"
A="$(make_app g2 abi)"; run_case g2 "$A" 78 no 0
[[ "$(npm_calls g2)" == 1 ]] && ok "G2: one rebuild attempt, no loop" || bad "G2: npm called $(npm_calls g2) times"
grep -q 'native-module-load-failed' "$A/.cc-state/cc-start-refused.json" 2>/dev/null \
  && ok "G2: durable refusal receipt names native-module-load-failed" || bad "G2: no/other receipt"
grep -q 'NODE_MODULE_VERSION' "$WORK/out-g2.txt" && ok "G2: the message carries the ABI numbers" || bad "G2: no ABI in message"

echo "[G3] non-ABI load error is refused, not rebuilt"
A="$(make_app g3 other)"; run_case g3 "$A" 78 no 1
[[ "$(npm_calls g3)" == 0 ]] && ok "G3: no rebuild for an unrelated error" || bad "G3: npm called"

echo "[G4] no better-sqlite3 installed: skipped"
A="$(make_app g4 none)"; run_case g4 "$A" 0 yes 0

echo "[R1] repair-command-center.sh pins the rebuild node"
REPAIR="${REPAIR_SCRIPT:-$REPO_ROOT/scripts/repair-command-center.sh}"
grep -q 'scripts/lib/node-runtime.sh' "$REPAIR" && grep -q 'export CC_NODE_BIN="$NODE_BIN"' "$REPAIR" \
  && ok "R1: repair resolves the node through node-runtime.sh" || bad "R1: repair still uses the ambient node"

echo ""
printf '[cc-start-sqlite-module-guard] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
