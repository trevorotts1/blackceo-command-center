#!/usr/bin/env python3
"""
One-shot migration: add the ZHC-spec files to dashboard agents/ folder.

Before: 23 agents × 4 files (AGENTS.md, SOUL.md, MEMORY.md, TOOLS.md), all
real files, no symlinks. Missing: IDENTITY.md, HEARTBEAT.md, USER.md.

After: 23 agents × 7 files. AGENTS.md / TOOLS.md / USER.md symlinked to
agents/_shared/. IDENTITY.md (per-agent, with Persona Governance Override)
and HEARTBEAT.md (per-agent) created. SOUL.md and MEMORY.md unchanged.

The agent's prior per-agent AGENTS.md content (which held a "Role" section
describing what the agent does) is preserved in the new IDENTITY.md.

Idempotent — safe to re-run.
"""
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENTS_DIR = REPO_ROOT / "agents"
SHARED_DIR = AGENTS_DIR / "_shared"

CEO_AGENTS = {"master-orchestrator"}

STANDARD_DEFERRAL = """## Persona Governance Override

When you are assigned a persona for a task, that persona governs HOW you perform
the work. Your beliefs, voice, decision logic, quality bar, and judgment for that
task come from the persona — not from this file.

Act AS IF you ARE the persona for the duration of the task. Use their frameworks.
Use their phrasing. Hold their standards. Make the calls they would make.

This file is your fallback identity. It governs only when no persona is assigned.
When a persona is present, this file is subordinate to it.

**Order of operations:**
1. Check for an assigned persona. If present → act AS that persona.
2. If no persona is assigned → use this file.
3. In all cases: honor the company's mission (workspace SOUL.md) and the owner's
   stated values (workspace USER.md).
"""

CEO_DEFERRAL = """## Persona Governance — CEO Mode

As the CEO / Master Orchestrator, you do NOT fully defer to assigned personas.
You use them as INPUT, but you remain accountable to the company's mission and
the owner's values at all times — those override the persona when there is conflict.

When a persona is assigned to a CEO-level task:
1. Read the persona's frameworks, voice, and decision logic. Consider them.
2. Compare to mission (workspace SOUL.md) and owner profile (workspace USER.md).
3. Where the persona ALIGNS → embody it for the task.
4. Where the persona CONFLICTS → mission and owner WIN. Log conflict in MEMORY.md.
5. Your own identity governs when no persona is assigned.

You are the protector of the mission. Personas are tools you use, not authorities
you serve.
"""

SHARED_AGENTS_MD = """# AGENTS.md — Company-Wide Agent Rules

This file is the same for every agent in the company. It is symlinked into
each agent's workspace from `agents/_shared/AGENTS.md`. Edit once here, every
agent inherits the change.

## Universal Behavior Rules

1. **Follow instructions precisely.** Don't improvise scope. Don't pad work.
   Don't add features the task didn't ask for.

2. **Report completion with evidence.** A claim of "done" without proof is a
   claim of "I haven't checked yet." Show the diff, the test output, the
   screenshot, the URL.

3. **Escalate blockers to Master Orchestrator.** When you cannot proceed,
   surface that immediately. Do not silently retry the same broken approach.

4. **Honor the assigned persona when present.** See your IDENTITY.md for the
   Persona Governance Override clause. The persona governs HOW you work; this
   file governs THAT you work to standard.

5. **Write to MEMORY.md when you learn something durable.** Decisions made,
   gotchas hit, owner preferences observed. Don't write transient state.

6. **No Anthropic models for sub-agent dispatch.** Use OpenRouter or
   Ollama Cloud (per company config). Anthropic models are reserved for the
   Master Orchestrator role.

7. **Read your inherited files at startup.** Every cycle: re-read AGENTS.md
   (this file), TOOLS.md, USER.md, and any persona assigned to this task.

## Universal Quality Bar

Before marking a task DONE:
- Self-check that the deliverable does what the task asked
- Self-check that no obvious failure mode was missed
- If persona was assigned: did you actually apply their methodology?
- Log post-task adherence verification per company protocol

## Forbidden Behavior

- Inventing capabilities you don't have ("I can't" beats "I'll pretend I can")
- Skipping the persona governance when one is assigned
- Marking DONE without verifying
- Editing this file (it's shared — edit `agents/_shared/AGENTS.md` instead)
"""

SHARED_TOOLS_MD = """# TOOLS.md — Company-Wide Tool Registry

This file is shared across all agents (symlinked from `agents/_shared/TOOLS.md`).
It enumerates the tools any agent in the company can reach. Per-agent tool
usage rules live in each agent's `how-to.md`.

## LLM Infrastructure

- **Primary (internal evals + sub-agent dispatch):** DeepSeek V4 Pro via Ollama Cloud
- **Fallback (when Ollama Cloud is unreachable):** Gemini 3.1 Flash Lite via OpenRouter
- **Master Orchestrator only:** Claude Opus / Sonnet (Anthropic) — cost-restricted

## Integrations

- **CRM:** GoHighLevel (GHL) — contacts, sequences, pipelines
- **Workflows:** n8n (self-hosted) — automations, scheduled jobs
- **Hosting:** Vercel (dashboard + landing pages), Hostinger VPS (OpenClaw runtime)
- **Source control:** GitHub (`trevorotts1/openclaw-onboarding`, `openclaw-onboarding-vps`, `blackceo-command-center`)
- **Storage:** Google Workspace (Drive / Docs / Sheets)
- **Voice/audio:** Fish Audio API
- **Search/research:** Tavily, Perplexity (via OpenRouter)
- **Media:** Replicate, ImgBB (image hosting)

## Credentials

Credentials live at canonical paths set by the install (`~/.openclaw/secrets/`
on Mac, `/data/.openclaw/secrets/` on VPS). NEVER store secrets in this file.
Reference them by name only. Each credential file is chmod 600.

## Tool Access by Tier

- **Strategic tier (Master Orchestrator):** All tools.
- **Execution tier (most agents):** Tools listed under each agent's `how-to.md`
  Section 4 ("Tools & Integrations"). Default: read-only unless explicitly granted.
- **Research tier (Research / Scraper agents):** Web fetch + research-grade
  search models. No write access to production systems.
"""

SHARED_USER_MD = """# USER.md — Owner Profile

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
  not Clawdbot; no Ant Farm; etc.).

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
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def stub_identity(agent_slug, role_description, is_ceo):
    title = agent_slug.replace("-", " ").title()
    deferral = CEO_DEFERRAL if is_ceo else STANDARD_DEFERRAL
    return f"""# {title} — IDENTITY

**Slug:** {agent_slug}
**Generated:** {now_iso()}

## Role
{role_description or f"{title} for the company."}

## What This Agent Is NOT
- Not a substitute for the persona assigned to a given task (see Persona Governance Override below)
- Not a substitute for the owner's judgment on strategic calls

## Tools
See symlinked `TOOLS.md` (shared across company).

## Behavior Rules
See symlinked `AGENTS.md` (shared across company).

## Owner Profile
See symlinked `USER.md` (shared across company).

{deferral}
"""


def stub_heartbeat(agent_slug):
    title = agent_slug.replace("-", " ").title()
    return f"""# {title} — HEARTBEAT

Cadence: every 30 minutes (default)
Owner: {agent_slug}

## Scheduled tasks
(Empty — populated as the agent acquires recurring duties.)

## On startup
1. Read `AGENTS.md` (shared rules)
2. Read `TOOLS.md` (shared tools)
3. Read `USER.md` (owner profile)
4. Read your own `IDENTITY.md`, `SOUL.md`, latest `MEMORY.md`
5. Check for any assigned persona for the incoming task
6. Begin task with persona governance (if assigned) or default identity
"""


def extract_role_from_old_agents_md(text):
    """Pull the per-agent 'Role' paragraph out of the legacy AGENTS.md."""
    match = re.search(r"^##\s+Role\s*\n+([\s\S]*?)(?=\n##|\Z)", text, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return ""


def ensure_shared_files():
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    files = {
        "AGENTS.md": SHARED_AGENTS_MD,
        "TOOLS.md":  SHARED_TOOLS_MD,
        "USER.md":   SHARED_USER_MD,
    }
    for name, content in files.items():
        path = SHARED_DIR / name
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            print(f"  [shared] wrote {path.relative_to(REPO_ROOT)}")
        else:
            print(f"  [shared] already exists: {path.relative_to(REPO_ROOT)}")


def replace_with_symlink(file_path: Path, target: Path):
    """Remove file (if it's a real file) and replace with a symlink."""
    if file_path.is_symlink():
        return False  # already a symlink
    if file_path.exists():
        file_path.unlink()
    rel_target = os.path.relpath(target, start=file_path.parent)
    file_path.symlink_to(rel_target)
    return True


def migrate_agent(agent_dir: Path):
    """Apply ZHC layout to a single agent folder. Idempotent."""
    slug = agent_dir.name
    is_ceo = slug in CEO_AGENTS

    summary = {"slug": slug, "added": [], "symlinked": [], "skipped": []}

    old_agents_md = agent_dir / "AGENTS.md"
    role_description = ""
    if old_agents_md.exists() and not old_agents_md.is_symlink():
        role_description = extract_role_from_old_agents_md(
            old_agents_md.read_text(encoding="utf-8", errors="replace")
        )

    identity_path = agent_dir / "IDENTITY.md"
    if not identity_path.exists():
        identity_path.write_text(
            stub_identity(slug, role_description, is_ceo), encoding="utf-8"
        )
        summary["added"].append("IDENTITY.md")
    else:
        summary["skipped"].append("IDENTITY.md (already exists)")

    heartbeat_path = agent_dir / "HEARTBEAT.md"
    if not heartbeat_path.exists():
        heartbeat_path.write_text(stub_heartbeat(slug), encoding="utf-8")
        summary["added"].append("HEARTBEAT.md")
    else:
        summary["skipped"].append("HEARTBEAT.md (already exists)")

    for shared_name in ("AGENTS.md", "TOOLS.md", "USER.md"):
        target = SHARED_DIR / shared_name
        file_path = agent_dir / shared_name
        replaced = replace_with_symlink(file_path, target)
        if replaced:
            summary["symlinked"].append(shared_name)

    return summary


def main():
    if not AGENTS_DIR.is_dir():
        print(f"ERROR: {AGENTS_DIR} does not exist", file=sys.stderr)
        return 1

    print("== Ensuring agents/_shared/ ==")
    ensure_shared_files()

    print("\n== Migrating per-agent folders ==")
    agent_dirs = sorted(p for p in AGENTS_DIR.iterdir()
                        if p.is_dir() and p.name != "_shared" and not p.name.startswith("."))
    total = 0
    for ad in agent_dirs:
        s = migrate_agent(ad)
        total += 1
        added = ",".join(s["added"]) or "—"
        symlinked = ",".join(s["symlinked"]) or "—"
        print(f"  {s['slug']:30s}  +files: {added:30s}  +links: {symlinked}")

    print(f"\n== Done. {total} agent folders migrated. ==")
    print(f"Shared root: {SHARED_DIR.relative_to(REPO_ROOT)}")

    # Verify symlink count
    symlinks = []
    for ad in agent_dirs:
        for s in ad.iterdir():
            if s.is_symlink():
                symlinks.append(s)
    print(f"Symlinks created: {len(symlinks)} (expected {total * 3})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
