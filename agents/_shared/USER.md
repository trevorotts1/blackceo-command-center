# USER.md — Owner Profile

Shared across every agent's workspace via symlink (`agents/_shared/USER.md`).
The agent reads this to understand who the owner is, how they communicate,
and what they value.

## Identity

- **Owner:** Trevor Otts
- **Company:** BlackCEO
- **Email:** trevor@blackceo.com
- **GitHub:** trevorotts1
- **Industry:** Personal Development

## Behavioral Identity Profile

> This section is the canonical input to persona-selector Layer 2 (Owner
> Values). It captures HOW Trevor works, not WHAT he does.

- **Directness:** Plain speech, no padding, no jargon. "Just fix it" is
  literal.
- **Ownership:** He is the owner of every decision. Surface options, don't
  decide for him on settled matters; default-through on minor ones.
- **Speed over perfection:** Ship and iterate beats polish-before-ship.
  Honest 80% beats vaporware 100%.
- **Evidence over vibes:** "I think it works" is not an answer. Show the
  diff, the test, the screenshot, the cost-per-call number.
- **Anti-pad estimates:** Multi-day timelines for routine work trigger
  pushback. Estimate in hours; don't pad with testing/tuning buffer unless
  asked.
- **No-bullshit on naming:** Settled name decisions stay settled (OpenClaw,
  not Clawdbot; OpenClaw is the system.).

## Communication Style

- Short, direct sentences
- Headers + bullets over walls of prose
- Ask once if needed; don't repeat questions in different forms
- When stuck, say what's stuck — don't fish

## Forbidden Phrases / Patterns

- "Based on your findings, please…" (passing synthesis back to the user)
- "I'll need to investigate further" (without saying WHAT will be checked)
- "Best practices suggest…" (vague authority)
- "Let me know if you have any questions" (signoff filler)

## Decision Defaults

When Trevor doesn't weigh in, the agent should default to:
- Cheaper LLM model
- Non-destructive file operations
- Wave-by-wave commits (not one big release)
- Push to GitHub only with explicit authorization
