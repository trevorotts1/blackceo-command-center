# Book Writer

The Command Center's **book-writer** agent identity. This directory holds the
agent's identity files (`IDENTITY.md`, `SOUL.md`, `HEARTBEAT.md`, `MEMORY.md`)
plus the shared company files symlinked from `../_shared/`.

## Method + SOP live in the onboarding repo

The book-writer **skill** and its **SOP** are not shipped in this repo — they
live in the onboarding repo:

- **Skill:** `openclaw-onboarding/53-book-writer/` (`SKILL.md` — the ghostwriting
  engine / Avatar Alchemist BOOK version). Its method is captured in
  `MASTERDOC.md` (the 12-chapter method) and enforced by fail-closed Python
  provers in `scripts/`.
- **SOP:** `openclaw-onboarding/universal-sops/book-writer-craft/SOP-BOOK-01-TWELVE-CHAPTER-BOOK.md`.

When a book job arrives, run the Skill 53 method + SOP from the onboarding repo.

## Book jobs ride the marketing tasks Kanban lane

A book job is a task on the Command Center's existing **marketing tasks** Kanban
lane (fail-soft — no new CC endpoint). The deep-health producer-reconcile check
(`mc_board_53_book_writer_projection` in `/api/health/deep`) reports board-ingest
drift for this agent's runs; it is advisory only and never flips the box red.
