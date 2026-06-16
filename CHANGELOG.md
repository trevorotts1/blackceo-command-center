## [v4.47.0] — 2026-06-16 — feat(qc): AF-SPELL spelling/acronym fidelity gate

Adds AF-SPELL, a fail-closed spelling/acronym QC criterion in qc-scorer.ts,
closing the gap where a rendered slide misspelled an acronym ("ZHC" wrong) and
QC passed it. OCRs each slide; every rendered token must match the slide's spec
copy (case/emphasis-insensitive), be a known acronym (ZHC/ZHW/KIE/GHL/...), or a
common English word — anything else is a HARD FAIL with a named reason. Money
tokens are owned by AF-NUM. Fail-closed if no vision key. Caps score below 8.5,
blocking review->Done, exactly like AF-LANG/AF-NUM. Tests: AF-SPELL 8/8;
AF-NUM/AF-LANG/AF-I14 regressions still pass.

