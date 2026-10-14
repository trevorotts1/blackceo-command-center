#!/usr/bin/env bash
# sync-presentation-engine.sh -- entry point for the generated-engine sync
# (Item 7, B7 two-copies design, decision (b)).
#
# presentation_job/ in this repo is GENERATED OUTPUT from the canonical
# package in trevorotts1/openclaw-onboarding, pinned to a named commit and
# guarded by a blob-SHA parity gate. Never edit presentation_job/ by hand;
# regenerate it here and let PARITY-MANIFEST.json prove what landed.
#
# Usage:
#   scripts/sync-presentation-engine.sh sync  --source <onboarding-checkout> --commit <full-sha>
#   scripts/sync-presentation-engine.sh verify [--warn]
#   scripts/sync-presentation-engine.sh drift --source <onboarding-checkout>
#
# --commit is mandatory for sync: an unpinned source is refused (exit 2),
# as is a target whose presentation_job/ carries uncommitted changes.
#
# No HOME sandbox (unlike regen-seam-parity-golden.sh): this tool runs only
# git plumbing against the two checkouts plus file writes under
# presentation_job/ in this repo. It imports no engine code and resolves no
# operator state, so there is no real workspace for it to touch.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The generator's default --target is its own repo root (this repo); an
# explicit --target after the subcommand overrides it.
exec python3 "$REPO_ROOT/scripts/sync-presentation-engine.py" "$@"
