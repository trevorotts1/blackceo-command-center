# TOOLS.md — Company-Wide Tool Registry

This file is shared across all agents (symlinked from `agents/_shared/TOOLS.md`).
It enumerates the tools any agent in the company can reach. Per-agent tool
boundaries (which of these tools an agent may use, and how) live in each agent's
own `IDENTITY.md` (Role) and `SOUL.md` (Boundaries) — both synced per agent.
There is no separate per-agent `how-to.md`; this registry plus the agent's
identity files are the complete tool contract.

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
- **Podcast hosting & distribution:** Podbean — episode upload, episode
  metadata (title, show notes, publish time), and distribution to the podcast
  feed. Credential: `PODBEAN_CLIENT_ID` + `PODBEAN_CLIENT_SECRET` (names only —
  values live at the canonical secrets path below). Boundary: the Podcast Agent
  may create and update DRAFT episodes; publishing to a live feed requires owner
  approval and is never triggered from a heartbeat.
- **Search/research:** Tavily, Perplexity (via OpenRouter)
- **Media:** Replicate, ImgBB (image hosting)

## Credentials

Credentials live at canonical paths set by the install (`~/.openclaw/secrets/`
on Mac, `/data/.openclaw/secrets/` on VPS). NEVER store secrets in this file.
Reference them by name only. Each credential file is chmod 600.

## Tool Access by Tier

- **Strategic tier (Master Orchestrator):** All tools.
- **Execution tier (most agents):** the tools in this registry, bounded by each
  agent's `IDENTITY.md` (Role) and `SOUL.md` (Boundaries). Default: read-only
  unless explicitly granted.
- **Research tier (Research / Scraper agents):** Web fetch + research-grade
  search models. No write access to production systems.
