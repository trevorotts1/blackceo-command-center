#!/bin/bash
# Phase 6b - Register Command Center and receive tunnel token in webhook response
# Usage: ./create-tunnel.sh <client-slug> <company-name> <contact-email>

set -euo pipefail

CLIENT_SLUG="${1:?Usage: ./create-tunnel.sh <client-slug> <company-name> <contact-email>}"
COMPANY_NAME="${2:?Missing company name}"
CONTACT_EMAIL="${3:?Missing contact email}"
WEBHOOK_URL="https://main.blackceoautomations.com/webhook/command-center-register-v3"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Installing..."
  if command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
  fi
fi

echo "[1/5] Requesting tunnel from Trevor's system..."
RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{\"clientName\":\"$CLIENT_SLUG\",\"companyName\":\"$COMPANY_NAME\",\"contactEmail\":\"$CONTACT_EMAIL\"}")

# Check if response is old format (just a string like 'Workflow was started')
if echo "$RESPONSE" | grep -q "Workflow was started"; then
  echo "ERROR: The tunnel automation needs updating."
  echo "Please ask Trevor to update the n8n workflow."
  exit 1
fi

STATUS=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "error")
if [ "$STATUS" != "success" ]; then
  echo "ERROR: webhook failed"
  echo "$RESPONSE"
  exit 1
fi

TUNNEL_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['tunnel'])")
SUBDOMAIN=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['subdomain'])")

echo "[2/5] Saving tunnel token to ~/.openclaw/.env"
mkdir -p ~/.openclaw
TMP_ENV=$(mktemp)
grep -v '^CLOUDFLARE_TUNNEL_TOKEN=' ~/.openclaw/.env 2>/dev/null > "$TMP_ENV" || true
echo "CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN" >> "$TMP_ENV"
mv "$TMP_ENV" ~/.openclaw/.env

echo "[3/5] Starting tunnel via PM2"
# The connector token is a bearer credential: never on argv. A token in the pm2
# command line lands in ~/.pm2/dump.pm2, its backups and `ps`. cloudflared reads
# it from a mode-600 file via --token-file instead.
TOKEN_FILE="$HOME/.openclaw/secrets/tunnel-command-center.token"
( umask 077; mkdir -p "$(dirname "$TOKEN_FILE")" )
( umask 077; printf '%s' "$TUNNEL_TOKEN" > "$TOKEN_FILE" )
chmod 600 "$TOKEN_FILE"
pm2 delete cloudflare-tunnel >/dev/null 2>&1 || true
# Tunnel targets localhost:4000 for Command Center
pm2 start "cloudflared tunnel run --token-file $TOKEN_FILE" --name cloudflare-tunnel >/dev/null
pm2 save >/dev/null

echo "[4/5] Waiting for tunnel to come online..."
sleep 15
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$SUBDOMAIN" 2>/dev/null || echo "000")

echo "[5/5] Result"
echo "Subdomain: https://$SUBDOMAIN"
echo "HTTP: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "SUCCESS: Command Center is live at https://$SUBDOMAIN"
else
  echo "WARNING: URL not live yet. Check: pm2 status cloudflare-tunnel"
fi
