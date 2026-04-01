# N8N Workflow Builder - Tools & Capabilities

## Available Tools
- n8n REST API (create, update, activate, deactivate workflows)
- JSON workflow export/import
- Webhook configuration

## n8n Instance
- **URL:** https://main.blackceoautomations.com/
- **API Key:** Stored in env vars as `N8N_API_KEY`
- **Auth Header:** `X-N8N-API_KEY: $N8N_API_KEY`

## Common Operations
- Create workflows from JSON definitions
- Activate/deactivate workflows
- List and search existing workflows
- Configure webhook triggers

## Environment Variables Required
- `N8N_API_KEY` — API key for n8n instance
- `N8N_BASE_URL` — Base URL of n8n instance (default: https://main.blackceoautomations.com/)
