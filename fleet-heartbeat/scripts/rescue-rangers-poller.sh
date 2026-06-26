#!/usr/bin/env bash
# rescue-rangers-poller.sh
#
# Mac-side half of the Rescue Rangers Relay (transport B: gateway-initiated pull).
#
# The cloud n8n workflow "Rescue Rangers Relay" (id GdymshUbNb9eaOAC) receives
# client-agent escalations over a public webhook, enforces the 25/day per-client
# cap, posts the problem into the operator Telegram group, and queues the ticket.
#
# This poller runs ON the operator Mac (where the rescue-rangers OpenClaw agent
# lives on loopback:18789). It:
#   1. POSTs {action:"pending"} to pull unanswered tickets.
#   2. For each ticket, runs ONE turn of the real rescue-rangers agent via
#      `openclaw agent --agent rescue-rangers --json` (gateway-initiated, so no
#      inbound reachability / tunnel is needed).
#   3. POSTs {action:"answer", ticketId, answer} back, which makes n8n post the
#      reply into the same Telegram group thread and return it to the caller.
#
# Idempotent: a ticket marked "answered" in n8n is not returned by "pending"
# again, so re-running this poller never double-answers.
#
# Intended to run from cron every minute or two. No em dashes in output.

set -u
set -o pipefail

RELAY_URL="${RESCUE_RELAY_URL:-https://main.blackceoautomations.com/webhook/rescue-rangers}"
PULL_LIMIT="${RESCUE_PULL_LIMIT:-10}"
AGENT_TIMEOUT="${RESCUE_AGENT_TIMEOUT:-540}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.local/bin/openclaw}"
LOG="${RESCUE_POLLER_LOG:-$HOME/.openclaw/logs/rescue-rangers-poller.log}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# 1) Pull pending tickets (include secret header when set, for auth-enforced relay).
_SECRET_ARGS=()
if [ -n "${RESCUE_RANGERS_WEBHOOK_SECRET:-}" ]; then
  _SECRET_ARGS=(-H "X-Rescue-Secret: ${RESCUE_RANGERS_WEBHOOK_SECRET}")
fi
PENDING_JSON="$(curl -s --max-time 30 -X POST "$RELAY_URL" \
  -H 'Content-Type: application/json' \
  "${_SECRET_ARGS[@]}" \
  -d "{\"action\":\"pending\",\"limit\":${PULL_LIMIT}}")"

COUNT="$(printf '%s' "$PENDING_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0)"
[ -z "$COUNT" ] && COUNT=0
if [ "$COUNT" -eq 0 ]; then
  exit 0
fi
log "pulled ${COUNT} pending ticket(s)"

# 2+3) For each ticket: run the rescue-rangers agent, post the answer back.
# Emit one TSV line per ticket: ticketId<TAB>prompt(base64)
printf '%s' "$PENDING_JSON" | python3 -c '
import sys, json, base64
d = json.load(sys.stdin)
tmpl = (
    "A fleet client OpenClaw agent is stuck and escalated to Rescue Rangers.\n"
    "Client: {client}\n"
    "Agent: {agent}\n"
    "Ticket: {ticket}\n\n"
    "Problem:\n{message}\n\n"
    "Give a concise, actionable fix or next step the client agent can apply now."
)
for t in d.get("tickets", []):
    prompt = tmpl.format(
        client=t.get("client",""),
        agent=t.get("agent",""),
        ticket=t.get("ticketId",""),
        message=t.get("message","") or "",
    )
    b64 = base64.b64encode(prompt.encode()).decode()
    print(t.get("ticketId","") + "\t" + b64)
' | while IFS=$'\t' read -r TICKET_ID PROMPT_B64; do
  [ -z "$TICKET_ID" ] && continue
  PROMPT="$(printf '%s' "$PROMPT_B64" | base64 --decode)"

  # Classify ticket difficulty (deterministic regex, zero LLM tokens).
  # Tiers: structured/light -> light model + thinking:low; hard -> deepseek/high.
  # HARD GUARDRAIL: destructive/credential keywords ALWAYS force hard.
  TIER_INFO="$(python3 -c '
import sys, re
msg = sys.argv[1] if len(sys.argv) > 1 else ""
LIGHT_MODEL="google/gemini-3-flash-preview"
destructive = re.search(r"rm\s+-rf|docker\s+volume\s+rm|git\s+reset\s+--hard|force.push|drop\s+table|truncate|delete\s+(all|database)|wipe|credential|secret|api.?key|token|password|auth\s+fail|unauthorized|403|data.?loss|security", msg, re.IGNORECASE)
if destructive:
    print("hard|||high|destructive/credential guardrail")
    sys.exit(0)
structured = re.search(r"agents\.list|schema\s+validation|AgentsConfigError|InvalidAgentsList|container.*(exited|dead|created)|exited.*container|gateway.port.*(closed|not.listening)|connect\s+ECONNREFUSED.*18789", msg, re.IGNORECASE)
if structured:
    print("structured|--model|" + LIGHT_MODEL + "|low|matches remediate class")
    sys.exit(0)
light = re.search(r"\[routing\s+test\]|\[synthetic\]|\btest\s+ticket\b", msg, re.IGNORECASE)
if light:
    print("light|--model|" + LIGHT_MODEL + "|low|routing test/synthetic/trivial")
    sys.exit(0)
print("hard|||high|default deepseek/high")
' "$PROMPT")"
  TIER="$(printf '%s' "$TIER_INFO" | cut -d'|' -f1)"
  MODEL_FLAG_KEY="$(printf '%s' "$TIER_INFO" | cut -d'|' -f2)"
  MODEL_FLAG_VAL="$(printf '%s' "$TIER_INFO" | cut -d'|' -f3)"
  THINKING_VAL="$(printf '%s' "$TIER_INFO" | cut -d'|' -f4)"
  TIER_REASON="$(printf '%s' "$TIER_INFO" | cut -d'|' -f5)"
  log "ticket ${TICKET_ID}: tier=${TIER} thinking=${THINKING_VAL} reason=${TIER_REASON}"

  # Build model flag (empty for hard/default; --model <id> for light/structured).
  MODEL_ARGS=()
  if [ -n "$MODEL_FLAG_KEY" ] && [ -n "$MODEL_FLAG_VAL" ]; then
    MODEL_ARGS=("$MODEL_FLAG_KEY" "$MODEL_FLAG_VAL")
  fi

  # Run one turn of the real rescue-rangers agent with tier-appropriate settings.
  AGENT_OUT="$("$OPENCLAW_BIN" agent --agent rescue-rangers --message "$PROMPT" --json --timeout "$AGENT_TIMEOUT" --thinking "$THINKING_VAL" "${MODEL_ARGS[@]}" 2>/dev/null)"
  ANSWER="$(printf '%s' "$AGENT_OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
i = raw.find("{")
try:
    d = json.loads(raw[i:])
except Exception:
    print(""); sys.exit(0)
# reply path proven from live run: result.meta.finalAssistantVisibleText
def dig(o, *keys):
    for k in keys:
        if not isinstance(o, dict): return None
        o = o.get(k)
    return o
ans = dig(d, "result", "meta", "finalAssistantVisibleText") \
   or dig(d, "result", "run", "meta", "finalAssistantVisibleText") \
   or dig(d, "meta", "finalAssistantVisibleText") or ""
print(ans)
')"

  if [ -z "$ANSWER" ]; then
    ANSWER="(rescue-rangers agent returned no text; please check the operator Mac gateway.)"
    log "ticket ${TICKET_ID}: EMPTY agent reply"
  else
    log "ticket ${TICKET_ID}: got reply (${#ANSWER} chars)"
  fi

  # Post the answer back to n8n (which posts to the group + returns to caller).
  # Include X-Rescue-Secret header if the env var is set (required when relay enforces auth).
  _RELAY_SECRET_HEADER=""
  if [ -n "${RESCUE_RANGERS_WEBHOOK_SECRET:-}" ]; then
    _RELAY_SECRET_HEADER="-H X-Rescue-Secret: ${RESCUE_RANGERS_WEBHOOK_SECRET}"
  fi
  RESP="$(curl -s --max-time 30 -X POST "$RELAY_URL" -H 'Content-Type: application/json' \
    ${_RELAY_SECRET_HEADER:+-H "X-Rescue-Secret: ${RESCUE_RANGERS_WEBHOOK_SECRET}"} \
    --data "$(python3 -c '
import sys, json
print(json.dumps({"action":"answer","ticketId":sys.argv[1],"answer":sys.argv[2]}))
' "$TICKET_ID" "$ANSWER")")"
  log "ticket ${TICKET_ID}: posted -> ${RESP}"
done

exit 0
