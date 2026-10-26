# `GET /api/version` (l24, oct-2026)

`src/app/api/version/route.ts` exposes the repo's canonical version string so a
dashboard can render its stamp and so "which build is this box serving" is
answerable at a glance.

## Response

```json
{
  "version": "v7.6.126",
  "checkoutVersion": "v7.6.126",
  "buildVersion": "v7.6.126"
}
```

- **`checkoutVersion`** — read live from the repo-root `version` file on every
  request. What the checkout says right now.
- **`buildVersion`** — recorded once, the first time the route module is
  evaluated, and never re-read. Immune to the checkout moving underneath the
  running process.
- **`version`** — legacy alias of `checkoutVersion`, kept for the dashboard
  footer chip.

The two named values **differ exactly when the checkout has moved since the
running build loaded the module** — the stale-build drift the endpoint exists to
diagnose, which used to be invisible because the endpoint read only the mutable
checkout while claiming to compare builds.

## Behaviour notes

- `force-dynamic`, no revalidate: always fresh.
- Never throws: a missing or unreadable `version` file degrades to HTTP 200 with
  `null` fields plus an `error` message naming every degraded read's cause — a
  diagnostic endpoint must not itself become a source of dashboard breakage, and
  a swallowed read error would leave a null field unexplained.
- `buildVersion` is a first-load record, not git-verified build provenance; the
  upgrade path (stamping the revision at build time via `next.config` `env`) is
  noted in the route source.
