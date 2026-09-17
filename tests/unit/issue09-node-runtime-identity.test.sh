#!/usr/bin/env bash
#
# issue09-node-runtime-identity.test.sh
#
# THE DEFECT (ISSUE-09): the Command Center had no node runtime identity.
# ecosystem.config.cjs ran `script: 'bash'` with no interpreter and no PATH;
# scripts/cc-start.sh exec'd a bare `node` off whatever PATH pm2 inherited;
# there was no .nvmrc or .node-version; `engines.node` accepted
# ^20.19.0 || ^22.13.0 || >=24, so Node 26 satisfied every gate; and
# `postinstall` compiles better-sqlite3 against whichever node ran npm. Client
# boxes ran the app under node@24 (module ABI 137) while cron and update shells
# resolved Node 26 (ABI 147), so every update reintroduced a
# NODE_MODULE_VERSION crash loop. The deploy's own native gate could not catch
# it: it called a bare `node -e require(...)`, which is the DEPLOY SHELL's node,
# not the one pm2 would exec.
#
# THE INVARIANTS UNDER TEST:
#
#   R1  the resolver prefers $CC_NODE_BIN over everything else
#   R3  an nvm install of the required major is found
#   R4  ambient `node` is accepted ONLY at the required major. This is the whole
#       fix: the old behaviour was to accept it unconditionally.
#   R5  no runtime at all exits 2 and NAMES every place it looked plus a remedy
#   R6  the resolver writes only the path to stdout, so a caller capturing it
#       can never end up with a warning banner as its node path
#   R7  --abi reports the resolved binary's module ABI
#
#   E1  both checked-in ecosystem configs export CC_NODE_BIN and put its
#       directory FIRST on PATH
#   E2  both THROW, with the remedy, when no runtime resolves. They must never
#       fall back to bare `node`: that silent fallback is the defect.
#
#   M1  the build manifest records node_abi and node_version
#
#   A1  cc-start.sh refuses (exit 78) when the artifact's recorded node_abi
#       differs from the runtime's, and writes a `native-abi-mismatch` receipt
#       carrying the atomic-deploy remedy
#   A2  it does NOT refuse when they match
#   A3  it does NOT refuse on MISSING evidence (a pre-ISSUE-09 manifest with no
#       node_abi field). Refusing on an absent field would brick every box
#       carrying an older artifact.
#
#   D1  atomic-deploy.sh feeds its native gate the resolved runtime through the
#       gate's own CCBI_NODE_BIN hook (which nothing ever set, so it fell
#       through to ambient `node`), and repairs a failing PRE-FLIGHT gate with
#       one rebuild rather than aborting with a manual command.
#
# KNOWN-GOOD CONTROL (R0): the resolver, pointed at a fixture whose ambient node
# IS the required major, must return that path and exit 0. Without it, a
# resolver that failed for an unrelated reason would make every "correctly
# refused" assertion below pass for the wrong reason.
#
# NOT COVERED HERE, and deliberately so: the two Homebrew keg steps
# (/opt/homebrew/opt/node@24 and /usr/local/opt/node@24) cannot be exercised by
# a fixture without writing into a real system prefix, and a test that installs
# Homebrew packages is worse than the gap. R5 proves the resolver LOOKS at both
# paths by name, which is the part a refactor could silently drop.
#
# Fixture-only: fake node binaries in a temp dir that answer --version and
# -p process.versions.modules. No real runtime is installed, moved or removed.
#
# Run: bash tests/unit/issue09-node-runtime-identity.test.sh

set -uo pipefail  # deliberately NOT -e: several invocations exit non-zero

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESOLVER="$REPO_ROOT/scripts/lib/node-runtime.sh"
CC_START="$REPO_ROOT/scripts/cc-start.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

for required in "$RESOLVER" "$CC_START"; do
  [[ -f "$required" ]] || { echo "FATAL: $required does not exist"; exit 1; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/issue09.XXXXXX")"
cleanup() { [[ -n "${ISSUE09_KEEP_WORK:-}" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

# make_fake_node <dir> <version e.g. v24.8.0> <abi e.g. 137>
make_fake_node() {
  local dir="$1" version="$2" abi="$3"
  mkdir -p "$dir"
  cat > "$dir/node" <<FAKENODE
#!/usr/bin/env bash
case "\${1:-}" in
  --version) printf '%s\n' "$version" ;;
  -p) [[ "\${2:-}" == "process.versions.modules" ]] && printf '%s\n' "$abi" || printf '\n' ;;
  *) exit 0 ;;
esac
FAKENODE
  chmod +x "$dir/node"
}

# ── R0: KNOWN-GOOD CONTROL ───────────────────────────────────────────────────
echo "[R0] control: ambient node AT the required major resolves cleanly"
make_fake_node "$WORK/path24" "v24.8.0" 137
R0_OUT="$(env -u CC_NODE_BIN -u NVM_DIR PATH="$WORK/path24:/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" 2>/dev/null)"; R0_RC=$?
if [[ "$R0_RC" == "0" && "$R0_OUT" == "$WORK/path24/node" ]]; then
  ok "R0: control resolves the ambient v24 node (the instrument works)"
else
  bad "R0: control failed (rc=$R0_RC out='$R0_OUT'); every assertion below is now meaningless"
fi

# ── R4: ambient node at the WRONG major is refused ───────────────────────────
echo "[R4] ambient node at the wrong major is NOT accepted"
make_fake_node "$WORK/path26" "v26.8.1" 147
R4_OUT="$(env -u CC_NODE_BIN -u NVM_DIR PATH="$WORK/path26:/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" 2>"$WORK/r4.err")"; R4_RC=$?
if [[ "$R4_RC" == "2" ]]; then
  ok "R4: a wrong-major ambient node exits 2 (pre-fix this was accepted silently)"
else
  bad "R4: expected exit 2, got $R4_RC (out='$R4_OUT')"
fi

# ── R5: the refusal names every source it checked, plus a remedy ─────────────
echo "[R5] the refusal names its sources and a remedy"
for needle in 'CC_NODE_BIN' '/opt/homebrew/opt/node@24/bin/node' '/usr/local/opt/node@24/bin/node' \
              'versions/node/v24' 'node on PATH' 'REMEDY' 'brew install node@24' 'nvm install 24'; do
  if grep -qF -- "$needle" "$WORK/r4.err"; then
    ok "R5: refusal names '$needle'"
  else
    bad "R5: refusal does not name '$needle'"
  fi
done
if grep -qF "v26.8.1" "$WORK/r4.err"; then
  ok "R5: refusal quotes the version it found and rejected"
else
  bad "R5: refusal does not say what it found on PATH"
fi

# ── R1: $CC_NODE_BIN wins ────────────────────────────────────────────────────
echo "[R1] CC_NODE_BIN takes precedence over every other source"
make_fake_node "$WORK/override" "v24.1.0" 137
R1_OUT="$(env -u NVM_DIR CC_NODE_BIN="$WORK/override/node" PATH="$WORK/path24:/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" 2>/dev/null)"; R1_RC=$?
if [[ "$R1_RC" == "0" && "$R1_OUT" == "$WORK/override/node" ]]; then
  ok "R1: the explicit override wins"
else
  bad "R1: expected the override, got rc=$R1_RC out='$R1_OUT'"
fi

echo "[R1b] an override at the wrong major is honoured but WARNED about"
R1B_OUT="$(env -u NVM_DIR CC_NODE_BIN="$WORK/path26/node" PATH="/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" 2>"$WORK/r1b.err")"; R1B_RC=$?
if [[ "$R1B_RC" == "0" && "$R1B_OUT" == "$WORK/path26/node" ]]; then
  ok "R1b: an explicit override is honoured as given"
else
  bad "R1b: expected the override honoured, got rc=$R1B_RC out='$R1B_OUT'"
fi
grep -q 'WARNING' "$WORK/r1b.err" && ok "R1b: the mismatch is warned about, never silent" \
  || bad "R1b: a wrong-major override was accepted silently"

# ── R6: stdout carries the path and nothing else ─────────────────────────────
echo "[R6] stdout is the path alone, even when a warning is printed"
if [[ "$(printf '%s' "$R1B_OUT" | wc -l | tr -d ' ')" == "0" && "$R1B_OUT" == "$WORK/path26/node" ]]; then
  ok "R6: a warning on the success path never contaminates the captured path"
else
  bad "R6: stdout was not a bare path: '$R1B_OUT'"
fi

# ── R3: nvm ──────────────────────────────────────────────────────────────────
echo "[R3] an nvm install of the required major is found"
make_fake_node "$WORK/nvm/versions/node/v24.4.0/bin" "v24.4.0" 137
make_fake_node "$WORK/nvm/versions/node/v24.10.0/bin" "v24.10.0" 137
R3_OUT="$(env -u CC_NODE_BIN NVM_DIR="$WORK/nvm" PATH="$WORK/path26:/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" 2>/dev/null)"; R3_RC=$?
if [[ "$R3_RC" == "0" && "$R3_OUT" == "$WORK/nvm/versions/node/v24."*"/bin/node" ]]; then
  ok "R3: an nvm v24 install is found and beats a wrong-major ambient node"
else
  bad "R3: expected an nvm v24 path, got rc=$R3_RC out='$R3_OUT'"
fi

# ── R7: --abi ────────────────────────────────────────────────────────────────
echo "[R7] --abi reports the resolved binary's module ABI"
R7_OUT="$(env -u NVM_DIR CC_NODE_BIN="$WORK/override/node" PATH="/usr/bin:/bin" \
  CC_NODE_REQUIRED_MAJOR=24 HOME="$WORK/nohome" bash "$RESOLVER" --abi 2>/dev/null)"
[[ "$R7_OUT" == "137" ]] && ok "R7: --abi prints 137" || bad "R7: --abi printed '$R7_OUT'"

# ── E1 / E2: the ecosystem configs ───────────────────────────────────────────
echo "[E1] both ecosystem configs export CC_NODE_BIN and lead PATH with it"
for config in ecosystem.config.cjs ecosystem.cc-prod.config.cjs; do
  E1_OUT="$(CC_NODE_BIN="$WORK/override/node" HOME="${HOME:-$WORK}" node -e '
    const c = require(process.argv[1]);
    const app = c.apps[0];
    process.stdout.write(JSON.stringify({ bin: app.env.CC_NODE_BIN, head: String(app.env.PATH || "").split(":")[0] }));
  ' "$REPO_ROOT/$config" 2>/dev/null)"
  if printf '%s' "$E1_OUT" | grep -qF "\"bin\":\"$WORK/override/node\""; then
    ok "E1: $config exports the resolved CC_NODE_BIN"
  else
    bad "E1: $config did not export CC_NODE_BIN (got: $E1_OUT)"
  fi
  if printf '%s' "$E1_OUT" | grep -qF "\"head\":\"$WORK/override\""; then
    ok "E1: $config puts the runtime directory FIRST on PATH"
  else
    bad "E1: $config does not lead PATH with the runtime directory (got: $E1_OUT)"
  fi
done

echo "[E2] both configs THROW with a remedy when no runtime resolves"
for config in ecosystem.config.cjs ecosystem.cc-prod.config.cjs; do
  # An unsatisfiable major with no override and no nvm: nothing can resolve.
  E2_ERR="$(env -u CC_NODE_BIN -u NVM_DIR CC_NODE_REQUIRED_MAJOR=99 HOME="${HOME:-$WORK}" \
    node -e 'require(process.argv[1])' "$REPO_ROOT/$config" 2>&1)"; E2_RC=$?
  if [[ "$E2_RC" != "0" ]]; then
    ok "E2: $config refuses to load without a runtime (never falls back to bare node)"
  else
    bad "E2: $config loaded anyway with no resolvable runtime"
  fi
  printf '%s' "$E2_ERR" | grep -q 'refusing to start' \
    && ok "E2: $config says it is refusing to start" \
    || bad "E2: $config throw does not say it is refusing"
  printf '%s' "$E2_ERR" | grep -q 'REMEDY' \
    && ok "E2: $config throw carries the resolver's remedy" \
    || bad "E2: $config throw lost the remedy"
done

# ── M1: the manifest records the build runtime ───────────────────────────────
echo "[M1] the build manifest records node_abi and node_version"
MF_APP="$WORK/mfapp"; mkdir -p "$MF_APP/.next"
CC_NODE_BIN="$WORK/override/node" bash "$REPO_ROOT/scripts/lib/build-inventory.sh" \
  --manifest "$MF_APP" "$MF_APP/.next" "issue09-build" "$(date +%s)" >/dev/null 2>&1
MF="$MF_APP/.next/build-inventory.json"
if [[ -f "$MF" ]]; then
  grep -q '"node_abi": "137"' "$MF" && ok "M1: node_abi records the BUILDING node's ABI" \
    || bad "M1: node_abi missing or wrong ($(grep node_abi "$MF" || echo absent))"
  grep -q '"node_version": "v24.1.0"' "$MF" && ok "M1: node_version records the building node's version" \
    || bad "M1: node_version missing or wrong"
else
  bad "M1: no manifest was written"
fi

# ── A1/A2/A3: the cc-start.sh ABI guard ──────────────────────────────────────
# The guard sits AFTER the build-freshness guard, so the fixture needs a tree
# that passes content verification. Rather than fake a whole verified artifact,
# drive the guard through its own contract: a manifest with a node_abi and a
# runtime reporting a different one.
echo "[A1/A2/A3] the cc-start.sh native ABI guard"
grep -q 'native-abi-mismatch' "$CC_START" \
  && ok "A1: cc-start.sh carries the native-abi-mismatch refusal reason" \
  || bad "A1: cc-start.sh has no native-abi-mismatch refusal"
grep -q '_ccbi_content_refusal_receipt "native-abi-mismatch"' "$CC_START" \
  && ok "A1: the mismatch writes the existing durable refusal receipt" \
  || bad "A1: the mismatch does not write a refusal receipt"
grep -q 'exec "\$CC_NODE_BIN"' "$CC_START" \
  && ok "A1: cc-start.sh execs the pinned runtime, not a bare node" \
  || bad "A1: cc-start.sh still execs a bare node"
grep -q 'exec node ' "$CC_START" \
  && bad "A1: a bare exec of node survives in cc-start.sh" \
  || ok "A1: no bare exec node remains"

# A3: missing evidence must NOT refuse. Prove the guard's own branches read as
# skip-not-refuse for an absent or unknown node_abi.
grep -q 'pre-ISSUE-09 manifest' "$CC_START" \
  && ok "A3: an artifact with no node_abi is skipped, not refused" \
  || bad "A3: no explicit skip for a manifest without node_abi"
grep -q 'no build-inventory.json to compare against' "$CC_START" \
  && ok "A3: an absent manifest is skipped, not refused" \
  || bad "A3: no explicit skip for an absent manifest"

# A2/A1 behavioural: run the guard's logic against fixture manifests.
abi_verdict() {  # abi_verdict <recorded-abi-json-fragment> <runtime-abi>
  local manifest="$1" runtime="$2" recorded
  recorded="$(sed -n 's/.*"node_abi"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -1 || true)"
  if [[ -z "$recorded" || "$recorded" == "unknown" ]]; then printf 'skip\n'; return 0; fi
  if [[ "$recorded" != "$runtime" ]]; then printf 'refuse\n'; else printf 'ok\n'; fi
}
printf '{"node_abi": "137"}\n' > "$WORK/mf-137.json"
printf '{"node_abi": "unknown"}\n' > "$WORK/mf-unknown.json"
printf '{"manifest_version": "1"}\n' > "$WORK/mf-legacy.json"
[[ "$(abi_verdict "$WORK/mf-137.json" 147)" == "refuse" ]] \
  && ok "A1: recorded 137 vs runtime 147 is a refusal" || bad "A1: mismatch did not refuse"
[[ "$(abi_verdict "$WORK/mf-137.json" 137)" == "ok" ]] \
  && ok "A2: matching ABIs proceed" || bad "A2: matching ABIs did not proceed"
[[ "$(abi_verdict "$WORK/mf-unknown.json" 147)" == "skip" ]] \
  && ok "A3: an 'unknown' recorded ABI is skipped" || bad "A3: 'unknown' was not skipped"
[[ "$(abi_verdict "$WORK/mf-legacy.json" 147)" == "skip" ]] \
  && ok "A3: a legacy manifest with no node_abi is skipped" || bad "A3: legacy manifest was not skipped"

# ── D1: atomic-deploy.sh gates on the pinned runtime ─────────────────────────
echo "[D1] atomic-deploy.sh gates on the pinned runtime and self-repairs once"
AD="$REPO_ROOT/scripts/atomic-deploy.sh"
# The gate itself is _ccbi_native_gate (it opens an in-memory SQLite database
# and runs a query, so a binary that exists but cannot execute is rejected).
# It already read CCBI_NODE_BIN, but nothing ever set it, so it fell through to
# `command -v node`: the deploy shell's node, not the one pm2 execs. Feeding it
# the resolved runtime is the fix.
grep -q 'export CCBI_NODE_BIN="${CCBI_NODE_BIN:-$CC_NODE_BIN}"' "$AD" \
  && ok "D1: the native gate is fed the resolved runtime, not ambient node" \
  || bad "D1: CCBI_NODE_BIN is still unset, so the gate falls through to ambient node"
grep -q 'local _gate_node="${CCBI_NODE_BIN:-$(command -v node)}"' "$AD" \
  && ok "D1: the gate honours CCBI_NODE_BIN (the hook this fix feeds)" \
  || bad "D1: the gate no longer reads CCBI_NODE_BIN; the wiring above is dead"
grep -q 'attempting ONE rebuild against' "$AD" \
  && ok "D1: a failing pre-flight gate triggers one automatic rebuild" \
  || bad "D1: the pre-flight gate still aborts instead of repairing once"
grep -q 'still fails after one automatic rebuild' "$AD" \
  && ok "D1: a second failure still aborts (one attempt, not a loop)" \
  || bad "D1: no bounded-attempt language in the abort path"
grep -q 'export PATH="${CC_NODE_DIR}:${PATH}"' "$AD" \
  && ok "D1: the deploy PATH leads with the resolved runtime (npm ci, build, rebuild)" \
  || bad "D1: the deploy PATH is not pinned to the resolved runtime"

# ── update.sh ────────────────────────────────────────────────────────────────
echo "[U1] update.sh requires the fleet major and pins PATH for npm ci"
US="$REPO_ROOT/update.sh"
grep -q 'node-runtime.sh' "$US" \
  && ok "U1: update.sh asks the single resolver" || bad "U1: update.sh does not use the resolver"
# Assert the ACCEPT BRANCH is gone, not the prose: this fix's own comment
# quotes the old range to explain why it was wrong, so a text match on the
# range string would fail against the fixed tree for the wrong reason.
grep -qE '\[ "\$major" -eq 22 \]|\[ "\$major" -eq 20 \]|"\$major" -ge 24' "$US" \
  && bad "U1: update.sh still has an accept branch for a non-24 major" \
  || ok "U1: the only accepted major in update.sh is 24"
grep -q '\[ "$major" -eq 24 \]' "$US" \
  && ok "U1: update.sh accepts exactly major 24" \
  || bad "U1: update.sh has no explicit major-24 accept"
grep -q 'export PATH="$(dirname "$CC_NODE_BIN"):$PATH"' "$US" \
  && ok "U1: update.sh prepends the runtime directory before npm ci" \
  || bad "U1: update.sh does not pin PATH for npm ci"
ENGINES="$(node -p "require('$REPO_ROOT/package.json').engines.node")"
[[ "$ENGINES" == ">=24 <25" ]] \
  && ok "U1: engines.node pins the fleet runtime (>=24 <25)" \
  || bad "U1: engines.node is '$ENGINES', expected '>=24 <25'"

echo ""
printf '[issue09-node-runtime-identity] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
