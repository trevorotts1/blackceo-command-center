# `check-updates.sh` — what an installed copy reports about itself

`check-updates.sh` is the read-only Sunday check. It never fetches into the
checkout, never updates the app, and writes only `.last-update-check`. Its JSON
is consumed by the box agent.

## Version vs commit

The repo-root `version` file is a **release stamp**. The version-consistency
gate (`.github/workflows/version-consistency.yml`) requires the five stamp
locations to agree; it does not require a bump on every commit, and CHANGELOG
entries land under `[Unreleased]` between cuts. A box can therefore be far
behind `origin/main` while `/version` reads the same string.

Verified at `4f3c859d4a94a5303f45703aed334f8e997ac046`: the last commit touching
`version` is `995504160154e7e4cf1df5f2d022c2bfbfec68c3`, and `origin/main` is 94
commits ahead of it with `/version` still `v7.6.126`.

The check therefore reports both signals, not the version alone.

## Fields

| Field | Meaning |
|---|---|
| `local_version` | trimmed `version` file of the installed checkout (may be empty) |
| `local_package_version` | `version` from the installed `package.json` |
| `local_commit` | full `git rev-parse HEAD` of the installed checkout; empty when the install dir did not resolve |
| `local_commit_short` | first 12 characters of `local_commit` |
| `remote_head` | `refs/heads/main` SHA from read-only `git ls-remote`; empty on network/auth failure |
| `remote_head_source` | how `remote_head` was read (`git ls-remote refs/heads/main`), empty when unknown |
| `commit_matches_remote_head` | `true` / `false` when both commits are known; `null` when either is unknown |
| `version_stamp_drift` | `true` when the versions are equal but the commits differ — the case a version-only check misses |
| `update_reason` | `none`, `version`, `commit`, `version+commit`, or `undetermined` |
| `has_update` | `true` when the version differs OR the commit differs from remote `main` |
| `latest_version` | remote `version` file from `main` |
| `changelog_excerpt` | first versioned or `[Unreleased]` CHANGELOG section |
| `changelog_excerpt_version` | the version that section names (`vX.Y.Z` or `Unreleased`) |
| `risk_hint` / `inferred_risk` | existing risk hints from that section |
| `install_dir` / `install_dir_status` / `install_dir_detail` | install resolution result |
| `script_version` | schema/version of this script |

## Boundary

- `has_update` compares content identity, not direction: a checkout with local
  commits ahead of `main` also differs. `update_reason` names which signal fired.
- No commit count (`commits_behind`) is reported. Counting requires ancestry
  data; a local `origin/main` ref can be stale and the check must not fetch.
  Unavailable data is reported as `null`/empty, never guessed.
- `git ls-remote` is read-only and bounded (`http.lowSpeedLimit`/`lowSpeedTime`),
  non-interactive (`GIT_TERMINAL_PROMPT=0`). Failure leaves commit detection
  undetermined rather than failing the check.
