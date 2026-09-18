#!/usr/bin/env bash
# ingest-task.sh — post a task to THIS Command Center's ingest endpoint from the
# box's own shell (the main agent's CLI path). Signs the body with the
# WEBHOOK_SECRET from the checkout's .env.local exactly like a webhook caller.
#
# Usage:
#   bash scripts/ingest-task.sh "<title>" [department_slug] [description]
#
# Prints the ingest response (task_id on success); non-zero on failure.
# Generic form of a per-box helper found on a client Mac (2026-09-18): the
# checkout directory and port are derived, never hardcoded, so the same file
# is correct on every box and the checkout stays clean for the updater.
set -euo pipefail
CC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$CC_DIR/.env.local"
[[ -f "$ENV_FILE" ]] || { echo "ingest-task: $ENV_FILE not found" >&2; exit 2; }
SECRET="$(sed -n -E 's/^WEBHOOK_SECRET=//p' "$ENV_FILE" | head -1 | sed -E "s/^[\"']//; s/[\"']\$//")"
[[ -n "$SECRET" ]] || { echo "ingest-task: WEBHOOK_SECRET missing in $ENV_FILE" >&2; exit 2; }
PORT="$(sed -n -E 's/^(CC_PORT|PORT)=//p' "$ENV_FILE" | head -1 | tr -d '"')"; PORT="${PORT:-4000}"

TITLE="${1:?title required}"
SLUG="${2:-general-task}"
DESC="${3:-}"

BODY=$(python3 -c "
import json, sys, time
print(json.dumps({
  'department_slug': sys.argv[1],
  'title': sys.argv[2],
  'description': sys.argv[3] or None,
  'source': 'main-agent-cli',
  'source_ref': 'main:ingest-task.sh',
  'idempotency_key': f'ingest-{int(time.time())}-{abs(hash(sys.argv[2]))}'
}))" "$SLUG" "$TITLE" "$DESC")

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -sS -X POST "http://127.0.0.1:${PORT}/api/tasks/ingest" \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: $SIG" \
  --data "$BODY"
echo
