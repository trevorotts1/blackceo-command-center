# N8N Workflow Builder - Tools & Capabilities

## Connection Info

- **URL:** https://main.blackceoautomations.com/
- **API Base:** https://main.blackceoautomations.com/api/v1
- **API Key:** Stored in env vars as `N8N_API_KEY`
- **Auth Header:** `X-N8N-API-KEY: $N8N_API_KEY`

## Authentication

All API calls require the `X-N8N-API-KEY` header. The key is stored in `~/.openclaw/openclaw.json` under `env.vars.N8N_API_KEY`.

```bash
# Example: test connection
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  https://main.blackceoautomations.com/api/v1/workflows | head -c 200
```

## API Call Examples

### 1. List All Workflows

```bash
curl -s -X GET \
  "https://main.blackceoautomations.com/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | jq '.data[] | {id, name, active}'
```

### 2. Get a Specific Workflow

```bash
curl -s -X GET \
  "https://main.blackceoautomations.com/api/v1/workflows/WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | jq '.'
```

### 3. Create a Workflow

```bash
curl -s -X POST \
  "https://main.blackceoautomations.com/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Automation",
    "nodes": [
      {
        "parameters": {},
        "id": "webhook-node",
        "name": "Webhook",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 1,
        "position": [250, 300]
      }
    ],
    "connections": {},
    "settings": {
      "executionOrder": "v1"
    }
  }' | jq '.'
```

### 4. Activate a Workflow

```bash
curl -s -X PATCH \
  "https://main.blackceoautomations.com/api/v1/workflows/WORKFLOW_ID/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | jq '.'
```

### 5. Deactivate a Workflow

```bash
curl -s -X PATCH \
  "https://main.blackceoautomations.com/api/v1/workflows/WORKFLOW_ID/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | jq '.'
```

### 6. Execute a Workflow via Webhook

```bash
curl -s -X POST \
  "https://main.blackceoautomations.com/webhook/YOUR_WEBHOOK_PATH" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "test_event",
    "data": { "message": "Hello from BlackCEO" }
  }' | jq '.'
```

### 7. Delete a Workflow

```bash
curl -s -X DELETE \
  "https://main.blackceoautomations.com/api/v1/workflows/WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

## Workflow Template: Webhook to Telegram

This is a simple working template. Webhook receives data, sends a Telegram message.

```json
{
  "name": "Webhook to Telegram",
  "nodes": [
    {
      "parameters": {
        "path": "blackceo-alert",
        "responseMode": "responseNode",
        "options": {}
      },
      "id": "webhook-1",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 1,
      "position": [250, 300]
    },
    {
      "parameters": {
        "chatId": "YOUR_CHAT_ID",
        "text": "={{ $json.body.message || 'Alert received' }}",
        "additionalFields": {
          "parse_mode": "Markdown"
        }
      },
      "id": "telegram-1",
      "name": "Send Telegram Message",
      "type": "n8n-nodes-base.telegram",
      "typeVersion": 1,
      "position": [500, 300]
    }
  ],
  "connections": {
    "Webhook": {
      "main": [
        [{ "node": "Send Telegram Message", "type": "main", "index": 0 }]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

### Deploy This Template via API

```bash
# Save the JSON above as /tmp/telegram-alert.json then:
curl -s -X POST \
  "https://main.blackceoautomations.com/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/telegram-alert.json | jq '.id'
```

## Environment Variables

| Variable | Description | Where Stored |
|----------|-------------|--------------|
| `N8N_API_KEY` | API key for n8n instance auth | `~/.openclaw/openclaw.json` env.vars |
| `N8N_BASE_URL` | Base URL of n8n (default: `https://main.blackceoautomations.com/`) | `~/.openclaw/openclaw.json` env.vars |

## Common Use Cases for BlackCEO Automations

- **Client onboarding:** Trigger a workflow when a new client is added in Command Center. Auto-create GHL contacts, send welcome emails, update databases.
- **Lead notifications:** Webhook receives form submissions from Convert and Flow, routes to Telegram/Slack with formatted alerts.
- **Data sync:** Scheduled workflows pull data from Google Sheets, Supabase, or GHL and push updates to other systems.
- **Report generation:** Cron-triggered workflows gather KPIs from multiple APIs and compile into daily/weekly reports.
- **Webhook bridges:** Connect tools that do not natively integrate (e.g., Stripe payment events to GHL opportunity updates).
- **Support ticket routing:** Incoming support form submissions get categorized and assigned to the right department.

## Troubleshooting

### 401 Unauthorized
- **Cause:** Missing or invalid API key.
- **Fix:** Verify `N8N_API_KEY` is set in `~/.openclaw/openclaw.json` env.vars. Test: `echo $N8N_API_KEY` should output the key. If empty, the env var is not loaded into the current session.

### 404 Not Found on Webhook
- **Cause:** Webhook path does not match, or the workflow is not active.
- **Fix:** Activate the workflow first (PATCH `/activate`). Check the exact webhook path in the workflow definition.

### Workflow Created but Not Executing
- **Cause:** Workflow is inactive by default after creation.
- **Fix:** Always PATCH `/api/v1/workflows/ID/activate` after creating a workflow.

### CORS Errors on Browser-Based Webhook Calls
- **Cause:** n8n webhooks do not allow cross-origin browser requests by default.
- **Fix:** Use server-side curl/API calls instead. Or configure n8n to accept CORS headers.

### Rate Limiting
- **Cause:** Too many rapid API calls.
- **Fix:** Add delays between bulk operations. n8n rate limits are configurable in `config/default.json` on the server.

### Workflow JSON Rejected on Create
- **Cause:** Invalid JSON structure, missing required fields (name, nodes, connections).
- **Fix:** Ensure every node has `parameters`, `id`, `name`, `type`, `typeVersion`, and `position`. Validate JSON before sending: `cat workflow.json | jq empty`
