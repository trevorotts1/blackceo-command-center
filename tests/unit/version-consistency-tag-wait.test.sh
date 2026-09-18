#!/usr/bin/env bash
# The tag guard's bounded wait must actually decide the verdict.
#
# .github/workflows/version-consistency.yml waits up to 300s for
# auto-tag-on-merge.yml to publish the release tag, because both fire on the
# same push and race. The wait loop `break`s when it finds the tag -- but a
# `break` leaves the FOR loop, not the enclosing IF block, so before the
# re-test was added control fell straight into the failure path even on the
# runs where the loop had just found the tag and said so. Measured on the
# v7.6.21 release push (merge 0b5cbdabc): one run logged "waiting for
# auto-tag-on-merge.yml", then "Tag v7.6.21 appeared after ~5s", then
# "NO TAG for v7.6.21" and exit 1, in that order. The wait therefore failed
# every release it raced, which is every release it existed to rescue.
#
# This test EXECUTES the real step body against a fake git rather than
# grepping it, so it measures behaviour and not wording. It ends with a
# MUTATION PROOF: the same cases are replayed against a deliberately
# re-broken copy, which must fail, so this test can never pass vacuously.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
WF=.github/workflows/version-consistency.yml
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo"
echo "v9.9.9" > "$TMP/repo/version"

# Extract the step body verbatim: from the `run: |` that follows the step's
# name, up to the next step, dedented out of its YAML block scalar.
awk '
  /^      - name: Verify annotated tag exists for current version/ { instep=1; next }
  instep && /^      - name: / { exit }
  instep && /^        run: \|/ { inrun=1; next }
  inrun { sub(/^ {10}/, ""); print }
' "$WF" > "$TMP/step.sh"

[ -s "$TMP/step.sh" ] && ok "extracted the tag-guard step body from $WF" \
                      || { bad "could not extract the step body from $WF"; printf '[version-consistency-tag-wait] %s passed, %s failed\n' "$PASS" "$FAIL"; exit 1; }
bash -n "$TMP/step.sh" && ok "the extracted step body is syntactically valid bash" \
                      || bad "the extracted step body does not parse"

# Fake git. The tag is ABSENT for the first $TAG_APPEARS_AFTER `git tag` calls
# and PRESENT after that, which is exactly the auto-tag race. Everything else
# answers as a healthy repo whose tag is annotated and on the right commit.
cat > "$TMP/bin/git" <<'FAKEGIT'
#!/bin/bash
C="$FAKE_STATE/tagcalls"
case "$1" in
  fetch) exit 0 ;;
  tag)
    n=$(( $(cat "$C" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$C"
    [ "$n" -gt "${TAG_APPEARS_AFTER:-0}" ] && echo "$WANT_TAG"
    exit 0 ;;
  rev-parse) [ "${2:-}" = "-q" ] && exit 0; echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0 ;;
  cat-file) echo "tag"; exit 0 ;;
  for-each-ref) echo "$WANT_TAG"; exit 0 ;;
  show) if [ "${2:-}" = "origin/main:version" ]; then echo "${BASE_VERSION:-$WANT_TAG}"; else echo "$WANT_TAG"; fi; exit 0 ;;
  ls-remote) echo "aaaaaaaa refs/tags/$WANT_TAG"; exit 0 ;;
esac
exit 0
FAKEGIT
# The bounded wait sleeps 5s per poll; a real sleep would make this test take
# five minutes to prove a logic bug, so time is faked, not shortened in the code.
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/sleep"
chmod +x "$TMP/bin/git" "$TMP/bin/sleep"

# $1 step file, $2 polls-before-tag-appears, $3 event, $4 base version
run_step() {
  rm -rf "$TMP/state"; mkdir -p "$TMP/state"
  ( cd "$TMP/repo" && PATH="$TMP/bin:/bin:/usr/bin" FAKE_STATE="$TMP/state" \
      WANT_TAG=v9.9.9 TAG_APPEARS_AFTER="$2" GITHUB_EVENT_NAME="$3" BASE_VERSION="${4:-v9.9.9}" \
      bash "$1" ) >"$TMP/out.txt" 2>&1
  return $?
}
expect() { # $1 label, $2 expected rc, $3.. run_step args
  local label="$1" want="$2"; shift 2
  run_step "$@"; local got=$?
  [ "$got" -eq "$want" ] && ok "$label (exit $got)" || { bad "$label — expected exit $want, got $got"; sed 's/^      /      /' "$TMP/out.txt" | tail -4; }
}

echo "  -- the release-push cases the wait exists for --"
expect "a tag already present passes"                     0 "$TMP/step.sh" 0   push
expect "a tag that lands on the 1st poll passes"          0 "$TMP/step.sh" 1   push
expect "a tag that lands on the 7th poll passes"          0 "$TMP/step.sh" 7   push
expect "a tag that lands on the last poll passes"         0 "$TMP/step.sh" 60  push
echo "  -- the cases that must still fail --"
expect "a tag that never lands still fails"               1 "$TMP/step.sh" 999 push
expect "a PR whose version is not newer still fails"      1 "$TMP/step.sh" 999 pull_request v9.9.9
echo "  -- pull-request behaviour is unchanged --"
expect "a PR preparing a newer version is allowed"        0 "$TMP/step.sh" 999 pull_request v9.9.8
expect "a PR whose tag already exists passes"             0 "$TMP/step.sh" 0   pull_request v9.9.8
echo "  -- manual re-runs (workflow_dispatch) --"
# Every workflow here gained workflow_dispatch so a dropped push event can be
# re-run on main without inventing a commit (measured: the v7.6.22 merge
# 3737ed4 fired zero workflows, and with no manual trigger the release could
# not be verified at all). A manual run is not a release race: the tag it is
# checking already exists, so the bounded wait must NOT engage. If it ever
# did, a manual re-run on a genuinely untagged tree would burn 300 seconds
# before reporting what it already knew.
expect "a manual run on a tagged tree passes"             0 "$TMP/step.sh" 0   workflow_dispatch
expect "a manual run with no tag fails without waiting"   1 "$TMP/step.sh" 999 workflow_dispatch
run_step "$TMP/step.sh" 999 workflow_dispatch
if grep -q "waiting for auto-tag-on-merge" "$TMP/out.txt"; then
  bad "a manual run entered the 300s release-race wait"
else
  ok "a manual run never enters the release-race wait"
fi


# The success message and the verdict must never contradict each other, which
# is the exact signature the live failure left in its log.
run_step "$TMP/step.sh" 1 push
if grep -q 'appeared after' "$TMP/out.txt" && grep -q 'NO TAG for' "$TMP/out.txt"; then
  bad "the log says the tag appeared AND that there is no tag, in the same run"
else
  ok "the log never claims the tag appeared and is missing in the same run"
fi

# ---- MUTATION PROOF -------------------------------------------------------
# Re-break the guard by neutralising the post-wait re-test (the SECOND
# occurrence of the tag test; the first is the initial check at the top), then
# replay the race cases. They MUST fail. If they pass, this test is measuring
# nothing and is not allowed to report success.
awk '/^ *if ! git tag -l "\$V_ROOT" \| grep -qx "\$V_ROOT"; then$/ { n++; if (n==2) { sub(/if !.*then$/, "if true; then"); } } { print }' \
  "$TMP/step.sh" > "$TMP/broken.sh"
if cmp -s "$TMP/step.sh" "$TMP/broken.sh"; then
  bad "mutation proof could not re-break the guard (the post-wait re-test was not found)"
else
  bash -n "$TMP/broken.sh" 2>/dev/null || bad "the mutated step body does not parse"
  mfail=0
  for polls in 1 7 60; do
    run_step "$TMP/broken.sh" "$polls" push
    [ $? -eq 0 ] && mfail=$((mfail+1))
  done
  [ "$mfail" -eq 0 ] && ok "mutation proof: without the re-test, every raced tag fails the guard" \
                     || bad "mutation proof FAILED — $mfail/3 raced cases passed even with the re-test removed"
  run_step "$TMP/broken.sh" 0 push
  [ $? -eq 0 ] && ok "mutation proof: the already-tagged case still passes when broken (the mutation is targeted)" \
               || bad "the mutation changed more than the raced path"
fi

printf '[version-consistency-tag-wait] %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
