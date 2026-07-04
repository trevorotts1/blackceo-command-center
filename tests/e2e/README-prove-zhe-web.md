# prove-zhe web e2e — P3-8

Proves that a completed interview driven through **this app's** interview seam
produces a Zero-Human-Everything (ZHE)-compliant build state, and **fails loudly**
if any ZHE gate is bypassable from the web path.

## What it drives

The real app seam (`src/lib/interview/seam.ts`) — the exact server layer every
`/api/interview/*` route calls — pressing the same Skill-23 shell scripts the
Telegram agent presses (`record-dept-decision.sh`, `update-interview-state.sh`)
and the same canonical floor printer (`list-canonical-departments.py`).

## The four ZHE gates asserted against the REAL enforcers

| Gate | Enforcer | Proof |
|------|----------|-------|
| Consent / exit **87** | `build-workforce._enforce_consent_or_refuse` | genuine transcript passes; missing/synthetic refuses 87 (fabrication + forced flag cannot bypass) |
| Decision-coverage / exit-**88** | seam coverage + `/api/interview/complete` pre-flight | full coverage completes; a gap blocks (409); a bare YES does not count |
| Provenanced decline (#8) | `build-workforce._canonical_decline_set` + seam | provenanced NO honored; a hand-written bare NO is rejected by both |
| Expected-set equality | `list-canonical-departments.py` + `department-floor.py` + seam | seam set == live canonical floor == department-floor; no hardcoded 28/29 |

Plus `prove-zhe.py --local`: the EXEMPT path passes for a not-completed box, and
`overall_pass` on a full-ZHE web-built company fixture.

## Sandbox safety (mandatory)

The Skill-23 scripts resolve `/data`-else-`$HOME` and **ignore** the app workspace
override — an un-sandboxed run corrupts the operator's live workspace. Every
invocation runs under a throwaway `HOME` (`mkdtemp`), and `assertSandboxed()`
refuses to proceed unless every resolved state path is inside it. The child `PATH`
is stripped of any `openclaw` binary so the `--complete` auto-closeout can never
fire a real Telegram build-kick.

## Run

```bash
# CI / deps installed (mirrors tests/e2e/duck-test.ts):
npm run test:prove-zhe-web

# Local, zero node_modules (Node >= 22.6, native TS type-stripping):
npm run test:prove-zhe-web:local

# Seeded-violation demonstration — exits 0 on a compliant build, non-zero on a
# seeded gate violation:
node --experimental-strip-types --import ./tests/e2e/ts-register.mjs \
  tests/e2e/prove-zhe-web.e2e.mjs --build [--seed=missing|bare-decline|synthetic]
```

Where the Skill-23 enforcers are not installed (e.g. a bare command-center CI
checkout), the suite **SKIPS loudly** — it never fake-passes. Point
`OPENCLAW_SKILL23_SCRIPTS` at an onboarding-skill checkout to run the full gate.
Wired into `.github/workflows/qc-cc.yml` as the `prove-zhe-web-e2e` job.
