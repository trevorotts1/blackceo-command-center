#!/usr/bin/env bash
# Every workflow that gates main must be runnable by hand.
#
# GitHub does not guarantee a push event produces workflow runs. Measured on
# this repo: the v7.6.22 merge (3737ed4) fired ZERO runs -- check_suites=0,
# actions/runs=0 -- while its own predecessor 0b5cbdabc has 11 and 9. With no
# workflow_dispatch trigger anywhere in .github/workflows, there was then no
# way to run CI on main at all, so that release shipped with no verdict and
# its tag had to be cut by hand. A re-run must never require inventing a
# commit just to make the gates fire.
#
# So: any workflow that runs on push to main MUST also accept
# workflow_dispatch. This is a pure YAML-shape assertion, parsed without
# PyYAML so it cannot fail on a runner whose python lacks the module.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

# Print the `on:` block of a workflow: from a top-level `on:` up to the next
# top-level key. Blank lines inside the block are kept.
on_block() {
  awk '
    /^on:[[:space:]]*$/ { inblock=1; next }
    inblock && /^[^[:space:]#]/ { exit }
    inblock { print }
  ' "$1"
}
runs_on_push_main() { # the on: block declares push: ... branches containing main
  awk '
    /^  push:[[:space:]]*$/ { inpush=1; next }
    inpush && /^  [a-z_]+:/ { inpush=0 }
    inpush && /branches:/ && /main/ { found=1 }
    inpush && /^ *- *main *$/      { found=1 }
    END { exit(found?0:1) }
  ' <<<"$1"
}
has_dispatch() { grep -qE '^  workflow_dispatch:[[:space:]]*$' <<<"$1"; }

shopt -s nullglob
WFS=(.github/workflows/*.yml .github/workflows/*.yaml)
[ "${#WFS[@]}" -gt 0 ] && ok "found ${#WFS[@]} workflow file(s) to check" \
                       || bad "no workflow files found — this test would pass vacuously"

GATING=0
for wf in "${WFS[@]}"; do
  block="$(on_block "$wf")"
  if [ -z "$block" ]; then bad "$(basename "$wf"): could not read its on: block"; continue; fi
  if runs_on_push_main "$block"; then
    GATING=$((GATING+1))
    if has_dispatch "$block"; then
      ok "$(basename "$wf") gates main and is manually runnable"
    else
      bad "$(basename "$wf") runs on push to main but has NO workflow_dispatch — a dropped push event would be unrecoverable"
    fi
  fi
done
[ "$GATING" -gt 0 ] && ok "$GATING workflow(s) gate pushes to main" \
                    || bad "no workflow was detected as gating main — the parser is broken, not the repo"

# ---- MUTATION PROOF -------------------------------------------------------
# Strip the trigger out of a copy and confirm the checks above actually notice.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
victim="${WFS[0]}"
for wf in "${WFS[@]}"; do
  if runs_on_push_main "$(on_block "$wf")"; then victim="$wf"; break; fi
done
grep -v -E '^  workflow_dispatch:[[:space:]]*$' "$victim" > "$TMP/mutated.yml"
mblock="$(on_block "$TMP/mutated.yml")"
if runs_on_push_main "$mblock" && ! has_dispatch "$mblock"; then
  ok "mutation proof: removing the trigger from $(basename "$victim") is detected"
else
  bad "mutation proof FAILED — the check cannot tell a missing workflow_dispatch from a present one"
fi

printf '[workflows-manually-runnable] %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
