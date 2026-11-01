#!/usr/bin/env bash
# ci-pin-drift.test.sh — the pin check must pass a pinned tree and FAIL every
# way a pin can drift back to a float. A gate that cannot bite proves nothing.
#
# ponytail: bash 3.2 + Node only, no test framework — add to a runner when the
# worked tree needs one; the assertions do not change.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-ci-pins.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-pin-drift.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ok — $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL — $1"; }

# Same instrument for every case: node scripts/check-ci-pins.mjs <root>.
run() { node "$CHECK" "$1" >"$WORK/out.txt" 2>&1 && echo 0 || echo $?; }

mutate() { # <root> <from> <to>
  node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.argv[1],".github/workflows");for(const f of fs.readdirSync(d)){const q=p.join(d,f);if(!fs.statSync(q).isFile())continue;const t=fs.readFileSync(q,"utf8");if(t.includes(process.argv[2]))fs.writeFileSync(q,t.split(process.argv[2]).join(process.argv[3]));}' "$1" "$2" "$3"
}

fresh() { # <name> -> copies the repo's workflows + checker into a clean root
  local root="$WORK/$1"
  mkdir -p "$root/.github/workflows" "$root/scripts"
  cp "$REPO_ROOT"/.github/workflows/*.yml "$root/.github/workflows/"
  cp "$CHECK" "$root/scripts/"
  echo "$root"
}

echo "ci-pin-drift self-test"

# 1. POSITIVE — the shipped tree is pinned and consistent.
rc=$(run "$REPO_ROOT")
if [ "$rc" = "0" ]; then ok "pinned tree passes (rc=0)"; else bad "pinned tree exited $rc"; fi

# 2. NEGATIVE — a float reintroduced is caught.
root=$(fresh float)
mutate "$root" "runs-on: ubuntu-24.04" "runs-on: ubuntu-latest"
rc=$(run "$root")
if [ "$rc" = "1" ] && node -e 'process.exit(require("fs").readFileSync(process.argv[1],"utf8").includes("floating runner")?0:1)' "$WORK/out.txt"; then
  ok "reintroduced ubuntu-latest caught as 'floating runner'"
else
  bad "float not caught or not named (rc=$rc)"
fi

# 3. NEGATIVE — an exact pin changed to a different image is caught as drift.
root=$(fresh drift)
mutate "$root" "runs-on: ubuntu-24.04" "runs-on: ubuntu-22.04"
rc=$(run "$root")
if [ "$rc" = "1" ] && node -e 'process.exit(require("fs").readFileSync(process.argv[1],"utf8").includes("runner pin drift")?0:1)' "$WORK/out.txt"; then
  ok "ubuntu-24.04 -> ubuntu-22.04 caught as 'runner pin drift'"
else
  bad "exact-pin drift not caught or not named (rc=$rc)"
fi

# 4. NEGATIVE — an action ref outside the reviewed set is caught.
root=$(fresh action)
mutate "$root" "actions/checkout@v4" "actions/checkout@v3"
rc=$(run "$root")
if [ "$rc" = "1" ] && node -e 'process.exit(require("fs").readFileSync(process.argv[1],"utf8").includes("action pin not in the reviewed set")?0:1)' "$WORK/out.txt"; then
  ok "actions/checkout@v3 caught as unreviewed action pin"
else
  bad "unreviewed action ref not caught or not named (rc=$rc)"
fi

# 5. INSTRUMENT CONTROL — scanning nothing must never read as a pass.
mkdir -p "$WORK/empty/.github/workflows"
rc=$(run "$WORK/empty")
if [ "$rc" = "2" ]; then ok "empty workflow scan is UNDETERMINED (rc=2), never pass"; else bad "empty scan exited $rc, want 2"; fi

echo "ci-pin-drift: $pass passed, $fail failed"
[ "$fail" = "0" ]
