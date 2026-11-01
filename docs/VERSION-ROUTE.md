# `GET /api/version` (l24, oct-2026)

`src/app/api/version/route.ts` exposes the version string AND the git commit
the checkout is on, so a dashboard can render its stamp and "which build is
this box serving" is answerable without guessing. The version string alone is
not build identity — see "What the version string cannot tell you" below.

## Response

```json
{
  "version": "v7.6.126",
  "checkoutVersion": "v7.6.126",
  "buildVersion": "v7.6.126",
  "checkoutCommit": "4f3c859d4a94a5303f45703aed334f8e997ac046",
  "buildCommit": "4f3c859d4a94a5303f45703aed334f8e997ac046"
}
```

- **`checkoutVersion`** — read live from the repo-root `version` file on every
  request. What the checkout says right now.
- **`buildVersion`** — recorded once, the first time the route module is
  evaluated, and never re-read. Immune to the checkout moving underneath the
  running process.
- **`checkoutCommit`** — the commit the checkout is on, read live via
  `git rev-parse HEAD` on every request. `null` when git or `.git` is absent;
  the cause is reported in `commitError`.
- **`buildCommit`** — the commit recorded at the same first-load moment as
  `buildVersion`. Same caveat: it is a first-load record, not git-verified
  build provenance.
- **`version`** — legacy alias of `checkoutVersion`, kept for the dashboard
  footer chip.

The named version/commit pairs **differ exactly when the checkout has moved
since the running build loaded the module** — the stale-build drift the
endpoint exists to diagnose, which used to be invisible because the endpoint
read only the mutable checkout while claiming to compare builds.

## What the version string cannot tell you

The `version` file is a **release stamp**, not a per-commit identity. This
repo's version-consistency gate requires the five stamp locations to agree; it
does not require a bump on every commit, and CHANGELOG entries land under
`[Unreleased]` between cuts. Verified at commit
`4f3c859d4a94a5303f45703aed334f8e997ac046` (2026-11-01): the last commit that
touched `version` is `995504160154e7e4cf1df5f2d022c2bfbfec68c3`
("chore(release): pins, stamps, README and changelog for oct-25 batch"), while
`origin/main` is 94 commits ahead of that commit and `/version` still reads
`v7.6.126`. Two boxes reading the same version string can therefore be running
different code. Use `checkoutCommit` (live) or the updater's check
(`check-updates.sh`, which reports `local_commit`, `remote_head`,
`commit_matches_remote_head` and `version_stamp_drift`) for that question.

## Behaviour notes

- `force-dynamic`, no revalidate: always fresh.
- Never throws: a missing or unreadable `version` file degrades to HTTP 200 with
  `null` fields plus an `error` message naming every degraded read's cause — a
  diagnostic endpoint must not itself become a source of dashboard breakage, and
  a swallowed read error would leave a null field unexplained.
- Commit reads degrade independently: a missing git binary or `.git` yields
  `checkoutCommit`/`buildCommit` of `null` plus `commitError`, while a clean
  version read still emits no `error` key.
- `buildVersion`/`buildCommit` are first-load records, not git-verified build
  provenance; the upgrade path (stamping the revision at build time via
  `next.config` `env`) is noted in the route source.
