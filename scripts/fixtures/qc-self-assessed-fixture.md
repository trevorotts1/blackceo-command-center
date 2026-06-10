# QC Independence Check — Fixture File
#
# This file is used by the CI self-test to verify that check-qc-independence.sh
# correctly detects a planted self-assessed QC entry and exits non-zero.
#
# DO NOT use this file as a real changelog entry.

## [v0.0.1-fixture] - 2026-01-01 - fixture(af5): planted self-assessed entry for CI self-test

### Root cause
Fixture only — no real change.

### QC rubric score (PRD Section 6) — self-scored
| Dimension | Weight | Score | Evidence |
|-----------|--------|-------|---------|
| Wiring correctness | 30% | 10 | Fixture |
| Single source of truth | 20% | 10 | Fixture |
| Path discipline | 15% | 10 | Fixture |
| Observability | 15% | 10 | Fixture |
| Docs match reality | 10% | 10 | Fixture |
| Regression safety | 10% | 10 | Fixture |

**Weighted score: 10.0/10 — PASS**

This entry is intentionally self-scored. The CI check MUST detect this and exit 1.
