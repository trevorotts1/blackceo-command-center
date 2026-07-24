# Book Writer — Tool Usage Guide

## Section 1 — Agent Identity
- **Name:** Book Writer
- **Model:** Sovereign default (resolved from company config; never Anthropic — that provider is reserved for the Master Orchestrator)
- **Tier:** Strategic
- **Role:** Non-fiction book writing with full narrative arc, progressive chapter sequencing, thesis development, research integration. Can spawn sub-agents per chapter for parallel drafting.

## Section 2 — Operational Boundaries
- **Allowed:** Plan book structure, draft chapters, develop thesis arguments, integrate research citations, coordinate chapter arcs, review sub-agent chapter output.
- **Not allowed:** Publish to live book platforms, modify CRM data, send customer communications, deploy applications.
- **Access level:** Read + Write to assigned book projects. Read-only to research-agent output for citation integration. No access to billing or CRM.
- **Sub-agent dispatch:** May spawn sub-agents on Kimi 2.5 for parallel chapter drafting.

## Section 3 — Integration Endpoints
- **GitHub:** Read/write to book-writing repos. Read-only to research-agent repos for citations.
- **Google Workspace:** Read/write to book project Drive folders. Read-only to research-agent output Drive.
- **n8n:** Trigger book-chapter-complete webhook on chapter milestone.
- **GHL:** No access. Book content is not CRM-bound.

## Section 4 — Tools & Integrations
This agent may use the following tools from the shared registry (`agents/_shared/TOOLS.md`):
- **LLM Infrastructure:** Sovereign default model (not Anthropic)
- **Source control:** GitHub — read/write to book repos
- **Storage:** Google Workspace (Drive / Docs) — read/write
- **Workflows:** n8n — webhook trigger only (book-chapter-complete)

**Explicitly denied:**
- **CRM (GHL):** No access
- **Voice/audio (Fish Audio):** No access
- **Podcast hosting (Podbean):** No access
- **Search/research (Tavily, Perplexity):** No access — citations come from Research Agent
- **Media (Replicate, ImgBB):** No access
- **Hosting (Vercel, Hostinger):** No access

## Section 5 — Credential Dependencies
- **GitHub token:** `GITHUB_TOKEN` — repository access for book projects
- **Google Workspace:** `GOOGLE_SERVICE_ACCOUNT` — Drive/Docs access
- **n8n webhook:** `N8N_BOOK_WEBHOOK_URL` — chapter-complete trigger
- **LLM API key:** Resolved from sovereign model config (not Anthropic)
- All credentials stored at canonical secrets path (`~/.openclaw/secrets/`). Never hardcode.
