## [v4.49.0] — 2026-06-16 — feat(qc): AF-COVERAGE anti-compression gate

Blocks a deck whose slide count is materially below what its source warrants (auto-fail) UNLESS a client_requested_slide_cap is on record. Closes the hole where a rich transcript (~2800 lines, warranting ~30-62 slides) got silently compressed to a 12-slide summary. Pure checkCoverage(): FAIL if actual < 90% of slide_count_target with no cap; FAIL if large source (>1500 lines) + target <20 with no cap; PASS at >=90% of target or when an explicit client cap is honored; fail-closed on unknown. Emitted for deck tasks. Tests: AF-COVERAGE 14/14; AF-PIPELINE/SPELL/NUM/LANG/I14 regressions pass; tsc clean.

