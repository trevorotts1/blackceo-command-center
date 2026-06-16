## [v4.48.0] — 2026-06-16 — feat(qc): AF-PIPELINE-COMPLETE gate (no shortcut-bypass)

Blocks review->Done for a deck unless the full-pipeline artifacts exist: a
completed research brief (working/research/brief-*.md research_complete:true), a
copy/image QC report, AND a real GHL media-upload record (ghl_media_id/folder_id
in media_library.json; seed null = not uploaded). Closes the hole where a
shortcut (hand-fed slides.json -> build_deck.py) could produce a "finished" deck
with no research, no QC log, and no GHL upload. Fail-closed; caps score below
8.5. Widened the deck/presentation task detector so decks reach the criteria
block. Tests: AF-PIPELINE 7/7; AF-SPELL/AF-NUM/AF-LANG/AF-I14 regressions pass
(21/21); tsc clean.

