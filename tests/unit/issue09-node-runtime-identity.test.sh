#!/usr/bin/env bash
#
# issue09-node-runtime-identity.test.sh
#
# THE DEFECT (ISSUE-09): drift between the node that BUILDS and REBUILDS the
# native modules and the node that RUNS the server. ecosystem.config.cjs ran
# `script: 'bash'` with no interpreter and no PATH, cc-start.sh exec'd a bare
# `node` off whatever pm2 inherited, and `postinstall` compiled better-sqlite3
# against whichever node ran npm. better-sqlite3 then threw
# NODE_MODULE_VERSION on every boot, and it recurred after every update.
#
# IT IS NOT A VERSION PROBLEM, and that distinction is the whole design. An
# earlier revision of this branch required Node 24 and set engines.node to
# ">=24 <25". Measured against the live fleet, that would have refused Command
# Center updates on most boxes: two client machines and the operator Mac run
# v26.7.0 or v26.8.1 with no node@24 present, and one VPS container runs
# v26.7.0 while its own pm2 process reports 25.6.1. A rule that locks the
# majority of the fleet out of updating replaces one outage with another.
#
# The rule is CONSISTENCY: one resolved node, used for npm ci, npm rebuild,
# next build, the deploy's native gate and cc-start's exec, with its path and
# ABI recorded in the build manifest so the next update reuses the same binary.
#
# THE INVARIANTS UNDER TEST:
#
#   R1   $CC_NODE_BIN wins over every other source
#   R1b  a CC_NODE_BIN that is not a usable node fails loudly, never silently
#        falls through to some other node
#   R2   the manifest's node_bin beats PATH. This is the continuity step and
#        the heart of the fix: rebuild with the binary that built what is on
#        disk and the ABI cannot drift out from under the server
#   R2b  a manifest node_bin that no longer exists is SKIPPED, not fatal
#   R3   the running CC pm2 process's node beats the known pins and PATH
#   R3b  a pm2 app that is NOT a Command Center is ignored
#   R4   the known pins beat PATH
#   R5   PATH carries NO version test. A Node 26 box resolves cleanly, which is
#        the fleet reality the version pin would have locked out
#   R6   nothing usable anywhere exits 2 and NAMES all five sources
#   R7   stdout is the resolved path alone, never a diagnostic
#   R8   --abi and --why report the ABI and the winning step
#
#   E1   both ecosystem configs export CC_NODE_BIN and lead PATH with it
#   E2   both THROW when nothing resolves, never fall back to bare `node`
#
#   M1   the manifest records node_bin, node_abi and node_version
#
#   A1   cc-start.sh refuses (exit 78) on an artifact/runtime ABI mismatch and
#        writes a `native-abi-mismatch` receipt carrying the deploy remedy
#   A2   it does NOT refuse when they match
#   A3   it does NOT refuse on MISSING evidence, so a box carrying an older
#        artifact is never bricked
#
#   D1   atomic-deploy.sh feeds its native gate the resolved runtime through
#        the gate's own CCBI_NODE_BIN hook, which nothing ever set
#   D2   the PATH prepend is CONDITIONAL, so it cannot shadow a deliberate npm
#   D3   a rebuild is verified by its ARTIFACT, not its exit code
#
#   U1   update.sh resolves identity first, then checks the RESOLVED node
#        against the declared engines range, which is back to its original
#        value
#
# KNOWN-GOOD CONTROL (R0): the resolver, given a fixture node on PATH and
# nothing else, must return it and exit 0. Without it, a resolver broken for an
# unrelated reason would make every "correctly refused" assertion pass for the
# wrong reason.
#
# NOT COVERED, deliberately: the Homebrew keg paths cannot be exercised without
# writing into a real system prefix, and a test that installs Homebrew packages
# is worse than the gap. R4 covers the known-pin STEP through the resolver's
# own override hook, and R6 proves both paths are named.
#
# Fixture-only: fake node and pm2 binaries in a temp dir. No real runtime is
# installed, moved or removed, and no pm2 daemon is contacted.
#
# Run: bash tests/unit/issue09-node-runtime-identity.test.sh

set -uo pipefail  # deliberately NOT -e: several invocations exit non-zero

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESOLVER="$REPO_ROOT/scripts/lib/node-runtime.sh"
CC_START="$REPO_ROOT/scripts/cc-start.sh"
AD="$REPO_ROOT/scripts/atomic-deploy.sh"
US="$REPO_ROOT/update.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

for required in "$RESOLVER" "$CC_START" "$AD" "$US"; do
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

# make_app_with_manifest <app_dir> <node_bin path to record>
make_app_with_manifest() {
  mkdir -p "$1/.next"
  printf '{\n  "manifest_version": "1",\n  "node_abi": "137",\n  "node_bin": "%s"\n}\n' "$2" > "$1/.next/build-inventory.json"
}

# make_fake_pm2 <dir> <jlist json>
make_fake_pm2() {
  local dir="$1" json="$2"
  mkdir -p "$dir"
  printf '%s' "$json" > "$dir/.jlist.json"
  cat > "$dir/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
[[ "${1:-}" == "jlist" ]] && cat "$(dirname "$0")/.jlist.json" && exit 0
exit 0
FAKEPM2
  chmod +x "$dir/pm2"
}

# Run the resolver with a controlled environment. Every invocation unsets
# CC_NODE_BIN unless the caller sets it, and points CC_APP_DIR at an empty
# directory unless the caller overrides it, so no step leaks into another.
EMPTY_APP="$WORK/empty-app"; mkdir -p "$EMPTY_APP"

make_fake_node "$WORK/onpath" "v26.8.1" 147
make_fake_node "$WORK/override" "v22.14.0" 127
make_fake_node "$WORK/frommanifest" "v24.8.0" 137
make_fake_node "$WORK/frompm2" "v25.6.1" 143
make_fake_node "$WORK/frompin" "v24.16.0" 137

BASE_PATH="$WORK/onpath:/usr/bin:/bin"

# ── R0: KNOWN-GOOD CONTROL ───────────────────────────────────────────────────
echo "[R0] control: a usable node on PATH resolves"
R0="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$EMPTY_APP" CCNR_KNOWN_PINS="" bash "$RESOLVER" 2>/dev/null)"; R0_RC=$?
if [[ "$R0_RC" == "0" && "$R0" == "$WORK/onpath/node" ]]; then
  ok "R0: control resolves the fixture node on PATH (the instrument works)"
else
  bad "R0: control failed (rc=$R0_RC out='$R0'); every assertion below is now meaningless"
fi

# ── R5: NO version test on PATH ──────────────────────────────────────────────
echo "[R5] PATH carries no version test: a Node 26 box resolves cleanly"
if [[ "$R0" == "$WORK/onpath/node" ]]; then
  ok "R5: v26.8.1 on PATH is accepted (the fleet reality a Node 24 pin would have locked out)"
else
  bad "R5: a Node 26 box did not resolve; the version pin has crept back in"
fi

# ── R1: CC_NODE_BIN wins ─────────────────────────────────────────────────────
echo "[R1] CC_NODE_BIN wins over every other source"
make_app_with_manifest "$WORK/app-r1" "$WORK/frommanifest/node"
make_fake_pm2 "$WORK/pm2-r1" '[{"name":"blackceo-command-center","pm2_env":{"env":{"CC_NODE_BIN":"'"$WORK"'/frompm2/node"}}}]'
R1="$(env CC_NODE_BIN="$WORK/override/node" PATH="$WORK/pm2-r1:$BASE_PATH" CC_APP_DIR="$WORK/app-r1" \
  CCNR_KNOWN_PINS="$WORK/frompin/node" bash "$RESOLVER" 2>/dev/null)"
[[ "$R1" == "$WORK/override/node" ]] \
  && ok "R1: the explicit override beats manifest, pm2, pins and PATH" \
  || bad "R1: expected the override, got '$R1'"

echo "[R1b] a CC_NODE_BIN that is not a usable node fails loudly"
R1B="$(env CC_NODE_BIN="$WORK/does-not-exist/node" PATH="$BASE_PATH" CC_APP_DIR="$EMPTY_APP" \
  CCNR_KNOWN_PINS="" bash "$RESOLVER" 2>"$WORK/r1b.err")"; R1B_RC=$?
if [[ "$R1B_RC" == "2" && -z "$R1B" ]]; then
  ok "R1b: a broken override exits 2 rather than silently using a different node"
else
  bad "R1b: expected exit 2 and no path, got rc=$R1B_RC out='$R1B'"
fi
grep -q 'not an executable node' "$WORK/r1b.err" \
  && ok "R1b: the failure says why" || bad "R1b: no explanation on stderr"

# ── R2: the manifest's node_bin beats PATH ───────────────────────────────────
echo "[R2] the manifest's node_bin beats the known pins and PATH (continuity)"
make_app_with_manifest "$WORK/app-r2" "$WORK/frommanifest/node"
R2="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$WORK/app-r2" \
  CCNR_KNOWN_PINS="$WORK/frompin/node" bash "$RESOLVER" 2>/dev/null)"
[[ "$R2" == "$WORK/frommanifest/node" ]] \
  && ok "R2: the node that built the served artifact is reused" \
  || bad "R2: expected the manifest node, got '$R2'"

R2_WHY="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$WORK/app-r2" \
  CCNR_KNOWN_PINS="" bash "$RESOLVER" --why 2>/dev/null)"
printf '%s' "$R2_WHY" | grep -q 'build-inventory.json node_bin' \
  && ok "R2: --why names the manifest as the winning step" \
  || bad "R2: --why did not name the manifest (got '$R2_WHY')"

echo "[R2b] a manifest node_bin that no longer exists is skipped, not fatal"
make_app_with_manifest "$WORK/app-r2b" "$WORK/deleted-node/node"
R2B="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$WORK/app-r2b" \
  CCNR_KNOWN_PINS="" bash "$RESOLVER" 2>/dev/null)"; R2B_RC=$?
if [[ "$R2B_RC" == "0" && "$R2B" == "$WORK/onpath/node" ]]; then
  ok "R2b: a stale recorded path falls through to the next step"
else
  bad "R2b: expected a fall-through to PATH, got rc=$R2B_RC out='$R2B'"
fi

# ── R3: the running CC pm2 process ───────────────────────────────────────────
echo "[R3] the running CC pm2 process's node beats the known pins and PATH"
make_fake_pm2 "$WORK/pm2-r3" '[{"name":"blackceo-command-center","pm2_env":{"env":{"CC_NODE_BIN":"'"$WORK"'/frompm2/node"}}}]'
R3="$(env -u CC_NODE_BIN PATH="$WORK/pm2-r3:$BASE_PATH" CC_APP_DIR="$EMPTY_APP" \
  CCNR_KNOWN_PINS="$WORK/frompin/node" bash "$RESOLVER" 2>/dev/null)"
[[ "$R3" == "$WORK/frompm2/node" ]] \
  && ok "R3: the live server's own node is reused when no manifest names one" \
  || bad "R3: expected the pm2 node, got '$R3'"

echo "[R3b] a pm2 app that is NOT a Command Center is ignored"
make_fake_pm2 "$WORK/pm2-r3b" '[{"name":"openclaw-gateway","pm2_env":{"env":{"CC_NODE_BIN":"'"$WORK"'/frompm2/node"}}}]'
R3B="$(env -u CC_NODE_BIN PATH="$WORK/pm2-r3b:$BASE_PATH" CC_APP_DIR="$EMPTY_APP" \
  CCNR_KNOWN_PINS="" bash "$RESOLVER" 2>/dev/null)"
[[ "$R3B" == "$WORK/onpath/node" ]] \
  && ok "R3b: a foreign pm2 app's node is never adopted" \
  || bad "R3b: adopted a node from a non-CC app (got '$R3B')"

# ── R4: known pins beat PATH ─────────────────────────────────────────────────
echo "[R4] the known pins beat PATH"
R4="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$EMPTY_APP" \
  CCNR_KNOWN_PINS="$WORK/frompin/node" bash "$RESOLVER" 2>/dev/null)"
[[ "$R4" == "$WORK/frompin/node" ]] \
  && ok "R4: a known pin wins over ambient PATH" \
  || bad "R4: expected the pin, got '$R4'"
grep -q '/opt/homebrew/opt/node@24/bin/node' "$RESOLVER" \
  && ok "R4: the real Homebrew pin is still listed in the resolver" \
  || bad "R4: the Homebrew pin was dropped from the resolver"

# ── R6: nothing usable anywhere ──────────────────────────────────────────────
echo "[R6] nothing usable anywhere exits 2 and names all five sources"
R6="$(env -u CC_NODE_BIN PATH="/usr/bin:/bin" CC_APP_DIR="$EMPTY_APP" \
  CCNR_KNOWN_PINS="" bash "$RESOLVER" 2>"$WORK/r6.err")"; R6_RC=$?
if [[ "$R6_RC" == "2" ]]; then
  ok "R6: exits 2 when no node can be found"
else
  bad "R6: expected exit 2, got $R6_RC (out='$R6'); is there a node in /usr/bin on this box?"
fi
for needle in 'CC_NODE_BIN' 'build-inventory.json node_bin' 'running CC pm2 process' 'known pins' 'node on PATH' 'REMEDY'; do
  grep -qF -- "$needle" "$WORK/r6.err" \
    && ok "R6: the refusal names '$needle'" \
    || bad "R6: the refusal does not name '$needle'"
done
grep -q 'enforced separately' "$WORK/r6.err" \
  && ok "R6: the refusal says the version RANGE is enforced elsewhere (identity vs support)" \
  || bad "R6: the refusal conflates identity with supportedness"

# ── R7 / R8 ──────────────────────────────────────────────────────────────────
echo "[R7] stdout is the resolved path alone"
if [[ "$(printf '%s' "$R2" | wc -l | tr -d ' ')" == "0" && "$R2" == "$WORK/frommanifest/node" ]]; then
  ok "R7: a caller capturing stdout gets a bare path"
else
  bad "R7: stdout was not a bare path: '$R2'"
fi

echo "[R8] --abi reports the resolved binary's module ABI"
R8="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$WORK/app-r2" CCNR_KNOWN_PINS="" \
  bash "$RESOLVER" --abi 2>/dev/null)"
[[ "$R8" == "137" ]] && ok "R8: --abi prints the manifest node's ABI (137)" || bad "R8: --abi printed '$R8'"

# ── E1 / E2: the ecosystem configs ───────────────────────────────────────────
echo "[E1] both ecosystem configs export CC_NODE_BIN and lead PATH with it"
for config in ecosystem.config.cjs ecosystem.cc-prod.config.cjs; do
  E1="$(CC_NODE_BIN="$WORK/override/node" HOME="${HOME:-$WORK}" node -e '
    const c = require(process.argv[1]);
    const a = c.apps[0];
    process.stdout.write(JSON.stringify({ bin: a.env.CC_NODE_BIN, head: String(a.env.PATH || "").split(":")[0] }));
  ' "$REPO_ROOT/$config" 2>/dev/null)"
  printf '%s' "$E1" | grep -qF "\"bin\":\"$WORK/override/node\"" \
    && ok "E1: $config exports the resolved CC_NODE_BIN" \
    || bad "E1: $config did not export it (got: $E1)"
  printf '%s' "$E1" | grep -qF "\"head\":\"$WORK/override\"" \
    && ok "E1: $config puts the runtime directory FIRST on PATH" \
    || bad "E1: $config does not lead PATH with it (got: $E1)"
done

echo "[E2] both configs THROW with a remedy when nothing resolves"
for config in ecosystem.config.cjs ecosystem.cc-prod.config.cjs; do
  E2_ERR="$(env -u CC_NODE_BIN PATH="/usr/bin:/bin" CC_APP_DIR="$EMPTY_APP" CCNR_KNOWN_PINS="" \
    HOME="${HOME:-$WORK}" "$WORK/onpath/../onpath/node" -e '' 2>/dev/null; \
    env -u CC_NODE_BIN CC_APP_DIR="$EMPTY_APP" CCNR_KNOWN_PINS="" HOME="${HOME:-$WORK}" \
    PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" \
    node -e 'process.env.PATH="/usr/bin:/bin"; require(process.argv[1])' "$REPO_ROOT/$config" 2>&1)"; E2_RC=$?
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
echo "[M1] the manifest records node_bin, node_abi and node_version"
MF_APP="$WORK/mfapp"; mkdir -p "$MF_APP/.next"
CC_NODE_BIN="$WORK/frommanifest/node" bash "$REPO_ROOT/scripts/lib/build-inventory.sh" \
  --manifest "$MF_APP" "$MF_APP/.next" "issue09-build" "$(date +%s)" >/dev/null 2>&1
MF="$MF_APP/.next/build-inventory.json"
if [[ -f "$MF" ]]; then
  grep -q "\"node_bin\": \"$WORK/frommanifest/node\"" "$MF" \
    && ok "M1: node_bin records the ABSOLUTE PATH of the building node" \
    || bad "M1: node_bin missing or wrong ($(grep node_bin "$MF" || echo absent))"
  grep -q '"node_abi": "137"' "$MF" && ok "M1: node_abi records its module ABI" || bad "M1: node_abi wrong"
  grep -q '"node_version": "v24.8.0"' "$MF" && ok "M1: node_version records its version" || bad "M1: node_version wrong"
else
  bad "M1: no manifest was written"
fi

echo "[M1b] the recorded node_bin is what the resolver reads back"
M1B="$(env -u CC_NODE_BIN PATH="$BASE_PATH" CC_APP_DIR="$MF_APP" CCNR_KNOWN_PINS="" \
  bash "$RESOLVER" 2>/dev/null)"
[[ "$M1B" == "$WORK/frommanifest/node" ]] \
  && ok "M1b: write then read round-trips, so the next update reuses the same binary" \
  || bad "M1b: the resolver did not read back what the manifest recorded (got '$M1B')"

# ── A1/A2/A3: the cc-start.sh ABI guard ──────────────────────────────────────
echo "[A1/A2/A3] the cc-start.sh native ABI guard"
grep -q 'native-abi-mismatch' "$CC_START" \
  && ok "A1: cc-start.sh carries the native-abi-mismatch refusal reason" \
  || bad "A1: cc-start.sh has no native-abi-mismatch refusal"
grep -q '_ccbi_content_refusal_receipt "native-abi-mismatch"' "$CC_START" \
  && ok "A1: the mismatch writes the existing durable refusal receipt" \
  || bad "A1: the mismatch does not write a refusal receipt"
grep -q 'exec "\$CC_NODE_BIN"' "$CC_START" \
  && ok "A1: cc-start.sh execs the resolved runtime, not a bare node" \
  || bad "A1: cc-start.sh still execs a bare node"
grep -q 'exec node ' "$CC_START" \
  && bad "A1: a bare exec of node survives in cc-start.sh" \
  || ok "A1: no bare exec node remains"
grep -q 'pre-ISSUE-09 manifest' "$CC_START" \
  && ok "A3: an artifact with no node_abi is skipped, not refused" \
  || bad "A3: no explicit skip for a manifest without node_abi"
grep -q 'no build-inventory.json to compare against' "$CC_START" \
  && ok "A3: an absent manifest is skipped, not refused" \
  || bad "A3: no explicit skip for an absent manifest"

abi_verdict() {  # abi_verdict <manifest> <runtime-abi>
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

# ── D1/D2/D3: atomic-deploy.sh ───────────────────────────────────────────────
echo "[D1] atomic-deploy.sh gates on the resolved runtime"
grep -q 'export CCBI_NODE_BIN="${CCBI_NODE_BIN:-$CC_NODE_BIN}"' "$AD" \
  && ok "D1: the native gate is fed the resolved runtime, not ambient node" \
  || bad "D1: CCBI_NODE_BIN is still unset, so the gate falls through to ambient node"
grep -q 'local _gate_node="${CCBI_NODE_BIN:-$(command -v node)}"' "$AD" \
  && ok "D1: the gate honours CCBI_NODE_BIN (the hook this fix feeds)" \
  || bad "D1: the gate no longer reads CCBI_NODE_BIN; the wiring above is dead"
grep -q 'attempting ONE rebuild against' "$AD" \
  && ok "D1: a failing pre-flight gate triggers one automatic rebuild" \
  || bad "D1: the pre-flight gate still aborts instead of repairing once"

# D2 exists because an unconditional prepend shipped on this branch and CI
# caught it: the runtime directory holds an `npm` as well as a `node`, so
# leading PATH with it also overrode the npm PATH deliberately pointed at. The
# B.2 fixtures put a stub npm on PATH; the real npm shadowed it, the staged
# dependency tree was never created, and ten deploy tests failed on a promotion
# step unrelated to this change. It passed locally because this machine's node
# directory contains no npm, which is why the check below builds its own
# directory holding BOTH binaries instead of trusting the local layout.
echo "[D2] the PATH prepend is conditional, so it cannot shadow a deliberate npm"
grep -q 'if \[\[ "$_cc_path_node" != "$CC_NODE_BIN" \]\]; then' "$AD" \
  && ok "D2: PATH is only rewritten when it would otherwise resolve a different node" \
  || bad "D2: the PATH prepend is unconditional; it will shadow a deliberate npm"

D2_DIR="$WORK/toolcache/bin"; mkdir -p "$D2_DIR"
make_fake_node "$D2_DIR" "v24.8.0" 137
printf '#!/usr/bin/env bash\nprintf "REAL-NPM\\n"\n' > "$D2_DIR/npm"; chmod +x "$D2_DIR/npm"
STUB_DIR="$WORK/fixture-stubs"; mkdir -p "$STUB_DIR"
printf '#!/usr/bin/env bash\nprintf "STUB-NPM\\n"\n' > "$STUB_DIR/npm"; chmod +x "$STUB_DIR/npm"

D2_WHICH="$(PATH="$STUB_DIR:$D2_DIR:/usr/bin:/bin" CC_NODE_BIN="$D2_DIR/node" bash -c '
  CC_NODE_DIR="$(dirname "$CC_NODE_BIN")"
  _cc_path_node="$(command -v node 2>/dev/null || printf "")"
  if [[ "$_cc_path_node" != "$CC_NODE_BIN" ]]; then export PATH="${CC_NODE_DIR}:${PATH}"; fi
  npm')"
[[ "$D2_WHICH" == "STUB-NPM" ]] \
  && ok "D2: a stub npm already on PATH still wins when the runtime is already first" \
  || bad "D2: the runtime directory shadowed a deliberate npm (got '$D2_WHICH'); this is the CI failure"

D2_NODE="$(PATH="$WORK/onpath:/usr/bin:/bin" CC_NODE_BIN="$D2_DIR/node" bash -c '
  CC_NODE_DIR="$(dirname "$CC_NODE_BIN")"
  _cc_path_node="$(command -v node 2>/dev/null || printf "")"
  if [[ "$_cc_path_node" != "$CC_NODE_BIN" ]]; then export PATH="${CC_NODE_DIR}:${PATH}"; fi
  command -v node')"
[[ "$D2_NODE" == "$D2_DIR/node" ]] \
  && ok "D2: PATH IS rewritten when it would otherwise resolve the wrong node" \
  || bad "D2: the conditional disabled the fix; node still resolves to '$D2_NODE'"

# D3: `npm rebuild` reports success without producing a binary. Measured on the
# operator Mac: it printed "rebuilt dependencies successfully" and exited 0
# while node_modules/better-sqlite3 held no .node file at all.
echo "[D3] a rebuild is verified by its artifact, not its exit code"
grep -q '_ccbi_assert_rebuild_produced_binary' "$AD" \
  && ok "D3: atomic-deploy asserts the rebuild produced a binary" \
  || bad "D3: atomic-deploy still trusts npm rebuild's exit code"
grep -q 'the resolved package does not load and execute SQLite' "$AD" \
  && ok "D3: the failure names the resolved functional artifact" \
  || bad "D3: no resolved-package functional language in the abort path"
grep -q '_cc_assert_native_module_usable' "$US" \
  && ok "D3: update.sh asserts the same after npm ci (where postinstall rebuilds)" \
  || bad "D3: update.sh trusts npm ci's exit code for the native module"

# Behavioural, not just a grep: extract update.sh's own assertion and run it
# against the states that matter. The `absent` case is why the check is scoped
# to INSTALLED packages (an absent package is npm ci's failure to report, and
# firing on it would mean no environment with a stubbed npm could ever run the
# updater, which is a worse trade than the coverage it buys).
#
# D3b (2026-09-21 regression lock): the `good` fixture below used to create
# build/Release/better-sqlite3.node, mirroring the hyphenated name update.sh
# derived from the package name. node-gyp names the artifact after binding.gyp's
# target_name, which is `better_sqlite3`, so BOTH the code and this fixture
# named a file that has never existed on a real box. The guard consequently
# fataled on every correctly installed box in the fleet and the updater aborted
# before migrations, build and restart. The fixture now writes the REAL
# artifact name, so it fails against the pre-fix update.sh and passes with it.
#
# The stub node decides whether the module "loads": update.sh treats loading as
# the verdict and the artifact path only as the choice of remedy, so the
# no-binary case is driven with a node that CANNOT load it — which is what a
# real node does when nothing was compiled.
make_fake_node "$WORK/noload" "v26.8.1" 147
cat > "$WORK/noload/node" <<'NOLOAD'
#!/usr/bin/env bash
case "${1:-}" in
  --version) printf 'v26.8.1\n' ;;
  -p) printf '147\n' ;;
  -e) exit 1 ;;   # require() of the native module throws: nothing compiled
  *) exit 0 ;;
esac
NOLOAD
chmod +x "$WORK/noload/node"

D3_FN="$(sed -n '/^_cc_assert_native_module_usable() {/,/^}/p' "$US")"
if [[ -z "$D3_FN" ]]; then
  bad "D3: could not extract _cc_assert_native_module_usable from update.sh"
else
  d3_run() {  # d3_run <case> [node dir]; prints SKIP | FATAL | OK + the message
    local mode="$1" node="${2:-$WORK/onpath}" dir="$WORK/d3-$1-$(basename "${2:-onpath}")"
    rm -rf "$dir"; mkdir -p "$dir"
    case "$mode" in
      absent)  : ;;  # no node_modules at all
      nobinary) mkdir -p "$dir/node_modules/better-sqlite3" ;;
      good)    mkdir -p "$dir/node_modules/better-sqlite3/build/Release"
               # The REAL node-gyp artifact name (binding.gyp target_name).
               : > "$dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ;;
    esac
    INSTALL_DIR="$dir" CC_NODE_BIN="$node/node" bash -c '
      set -uo pipefail
      fatal()   { printf "FATAL %s\n" "$*"; exit 1; }
      warn()    { printf "SKIP %s\n" "$*"; }
      success() { printf "OK %s\n" "$*"; }
      '"$D3_FN"'
      _cc_assert_native_module_usable better-sqlite3
    ' 2>/dev/null | head -1
  }
  [[ "$(d3_run absent)" == SKIP* ]] \
    && ok "D3: a package that is not installed at all is skipped, not fataled" \
    || bad "D3: an absent package fataled; a stubbed-npm environment could never update"
  D3_NOBIN="$(d3_run nobinary "$WORK/noload")"
  [[ "$D3_NOBIN" == FATAL* ]] \
    && ok "D3: a package present with NO compiled binary is fatal (the silent-success defect)" \
    || bad "D3: an installed package with no .node file was accepted"
  [[ "$D3_NOBIN" == *better_sqlite3.node* ]] \
    && ok "D3b: the remedy names the REAL node-gyp artifact (better_sqlite3.node)" \
    || bad "D3b: the remedy names '$D3_NOBIN' — the hyphenated guess is back"
  [[ "$D3_NOBIN" != *better-sqlite3.node* ]] \
    && ok "D3b: the hyphenated package-name spelling is gone from the artifact path" \
    || bad "D3b: update.sh still derives build/Release/better-sqlite3.node"
  [[ "$(d3_run good)" == OK* ]] \
    && ok "D3b: a REAL install (better_sqlite3.node) passes — the fleet-wide false fatal is fixed" \
    || bad "D3b: a correctly installed box was rejected; the updater still aborts fleet-wide"
  [[ "$(d3_run nobinary)" == OK* ]] \
    && ok "D3b: a module that LOADS is accepted even with no artifact at the derived path" \
    || bad "D3b: a working module was fataled because a guessed path did not match"
fi

# ── U1: update.sh ────────────────────────────────────────────────────────────
echo "[U1] update.sh resolves identity, then checks the RESOLVED node against engines"
grep -q 'node-runtime.sh' "$US" \
  && ok "U1: update.sh asks the single resolver" || bad "U1: update.sh does not use the resolver"
grep -q 'version=$("$CC_NODE_BIN" --version' "$US" \
  && ok "U1: the range check reads the RESOLVED node, not ambient node" \
  || bad "U1: the range check still reads ambient node"
grep -qE '\[ "\$major" -eq 24 \] *$' "$US" \
  && bad "U1: the ==24 pin is still in update.sh" \
  || ok "U1: the ==24 pin is gone"
ENGINES="$(node -p "require('$REPO_ROOT/package.json').engines.node")"
[[ "$ENGINES" == "^20.19.0 || ^22.13.0 || >=24" ]] \
  && ok "U1: engines.node is back to its original range (the fleet can update)" \
  || bad "U1: engines.node is '$ENGINES', expected the original range"

echo ""
printf '[issue09-node-runtime-identity] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
