# Presentation-engine vendor sync (`presentation_job/`)

`presentation_job/` in this repo is **generated output**, never hand-edited. It is
synced from the canonical package in `trevorotts1/openclaw-onboarding` and guarded
by a parity manifest.

Tool: `scripts/sync-presentation-engine.py` (wrapper: `scripts/sync-presentation-engine.sh`).

## Commands

```bash
scripts/sync-presentation-engine.sh sync   --source <onboarding-checkout> --commit <full-sha>
scripts/sync-presentation-engine.sh verify [--warn]
scripts/sync-presentation-engine.sh drift  --source <onboarding-checkout>
```

- **sync** replaces `presentation_job/` wholesale from the pinned canonical commit
  and writes `presentation_job/PARITY-MANIFEST.json` (per-file git blob SHA +
  sha256 + byte count, the pinned commit, and the package content digest).
- **verify** checks the worktree against the manifest — every listed file present
  with matching blob SHA and sha256, no unlisted files, the digest recomputes, and
  the engine contract invariants hold. This is the CI parity gate
  (`.github/workflows/presentation-engine-parity.yml`, warn-first).
- **drift** compares the pinned commit against a source checkout's current tree
  (weekly drift workflow, `.github/workflows/presentation-engine-drift.yml`).

Exit codes: `0` ok / `1` verification failed / `2` usage or refusal / `3` drift found.

## Canonical-source verification (l22, oct-2026)

`sync` used to stamp the constant canonical repo name onto whatever checkout it
was given. It now refuses (exit 2) unless the source is provably canonical:

- The source's remote URL is **normalized** — `scp`-style, ssh, and https forms
  are accepted; credentials, ports and path suffixes are stripped — and must
  resolve to `github.com/trevorotts1/openclaw-onboarding`. A checkout that merely
  carries the package tree is not canonical and is never stamped as such.
- A URL whose `scp user@host` userinfo hides a foreign scheme is **refused**
  (e.g. `javascript:alert(1)@github.com/owner/repo`, which git routes to ssh
  host `javascript` — the scheme and the userinfo are parsed separately, so
  userinfo text can never be read as the transport scheme).
- `--commit` must be **reachable from the canonical remote's fetched mainline**
  before anything is copied; an off-mainline sha is refused.
- The target's `presentation_job/` must be clean — uncommitted changes are
  refused, because sync replaces the directory wholesale.

On success the manifest records the **verified** source (repo, remote, url,
mainline ref). The moving mainline tip is deliberately not recorded so a second
sync with the same `--commit` is idempotent.

`tests/unit/pres037-sync-presentation-engine-source.test.sh` proves the
wrong-remote and off-mainline refusals, the accepted canonical case, the recorded
source block, and second-run idempotence.

## Digest note

`PARITY-MANIFEST.json`'s `package_digest` is computed over the synced files
excluding the manifest itself. The runtime census in `presentation_job/` still
counts the manifest as one extra top-level `.json`, so a runtime-reported digest
differs from canonical's by exactly that file until the canonical side adopts the
same exclusion. Recorded in the generator docstring, not hidden.
