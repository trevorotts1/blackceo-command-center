# CEO-board no-fabrication (`RepositoryStatusCard`, l20, oct-2026)

`src/components/ceo-board/RepositoryStatusCard.tsx` used to default to a sample
project (`luminous-core-api`, 14 PRs, 3 issues, build 2904, success, "2 mins
ago") and was rendered prop-less, so `/ceo-board/[dept]` displayed a healthy
stranger's repository as if it were real data.

## Behaviour

- Every prop is optional and starts **absent**, not defaulted.
- Any field with no measured value renders the literal text **`Not measured`**
  (`NOT_MEASURED` constant) — never a stand-in sample, never a blank that looks
  like zero.
- A measured **zero is a real measurement and renders as zero**: only
  `undefined` / non-finite counts count as absent (`hasNumber`), and only an
  empty/whitespace string counts as absent text (`hasText`).
- Build status shows `Success`/`Failed` (with `#<buildNumber>` when measured)
  only when `buildSuccess` is a boolean; otherwise `Not measured`.

The app-dev KPI tiles on the same page follow the same rule: they render from
measured snapshots only, with `Not measured` for absence — the previous `|| 84.36`
style fallback substituted sample numbers for missing AND zero snapshots alike.

Pinned by `tests/unit/l20-repository-status-card-not-measured.test.tsx`
(vitest.l20-cc-card.config.ts): a prop-less card fabricates nothing, and a
measured zero stays zero.
