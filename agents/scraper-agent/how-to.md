# Scraper Agent — Tool Usage Guide

## Section 1 — Agent Identity
- **Name:** Scraper Agent
- **Model:** minimax/minimax-m2.5
- **Tier:** Execution
- **Role:** Web scraping, data extraction, site crawling, pagination handling, rate limiting, anti-bot workarounds.

## Section 2 — Operational Boundaries
- **Allowed:** Scrape public websites, extract structured data, crawl sites with pagination, handle rate limiting, implement anti-bot workarounds, deliver extracted data to requesting agents.
- **Not allowed:** Scrape sites with robots.txt disallow without owner approval, bypass login/paywalls without authorization, modify scraped data beyond extraction formatting, send customer communications, modify CRM data.
- **Access level:** Read-only web access for scraping. Write extracted data to shared Drive. No access to CRM, billing, or customer PII.
- **Sub-agent dispatch:** May not spawn sub-agents (Execution tier).

## Section 3 — Integration Endpoints
- **Web:** Outbound HTTP/HTTPS for scraping. No inbound web server access.
- **Google Workspace:** Write extracted data to shared Drive (Sheets/CSV). Write scrape reports to Docs.
- **n8n:** Receive scrape-request triggers from other agents. Emit scrape-complete webhook with data location.
- **GitHub:** Read-only — scraping-script repos for methodology reference.
- **GHL:** No access.

## Section 4 — Tools & Integrations
This agent may use the following tools from the shared registry (`agents/_shared/TOOLS.md`):
- **LLM Infrastructure:** minimax/minimax-m2.5
- **Storage:** Google Workspace (Drive / Sheets) — write extracted data
- **Workflows:** n8n — scrape-request listener, scrape-complete emitter
- **Source control:** GitHub — read-only scraping-script repos

**Explicitly denied:**
- **CRM (GHL):** No access
- **Hosting (Vercel, Hostinger):** No access
- **Voice/audio (Fish Audio):** No access
- **Podcast hosting (Podbean):** No access
- **Search/research (Tavily, Perplexity):** No access — scraping is direct, not search API
- **Media (Replicate, ImgBB):** No access

## Section 5 — Credential Dependencies
- **Google Workspace:** `GOOGLE_SERVICE_ACCOUNT` — Drive/Sheets access for extracted data
- **GitHub token:** `GITHUB_TOKEN` — read-only scraping repos
- **n8n webhook:** `N8N_SCRAPE_WEBHOOK_URL` — request/completion triggers
- No scraping-specific API keys — uses direct HTTP access. Rotating user-agent handled by runtime config.
- All credentials stored at canonical secrets path (`~/.openclaw/secrets/`). Never hardcode.
