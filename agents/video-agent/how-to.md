# video-agent — Tool Usage Guide

This agent uses the tools registered in `agents/_shared/TOOLS.md`.

**Integration endpoints active on this box:**
- GHL (GoHighLevel): CRM contacts, pipelines, sequences
- n8n: workflow automations
- GitHub: source control
- Google Workspace: Drive, Docs, Sheets

**Credentials:** All credentials are stored at the canonical secrets path. Never hardcode.

**Boundary:** This agent may not publish live content, deploy to production, or spend money without explicit owner approval.
