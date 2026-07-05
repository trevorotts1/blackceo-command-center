#!/usr/bin/env bash
# Tests for rescue-outage-ticket.sh (FIX-RESCUE-06).
#
# Client-name-free: uses synthetic "Acme Co" / failure classes only.
# Self-contained: no network — the POST is captured via the RR_OUTAGE_POST_CMD
# seam and the resulting JSON is validated field-by-field with node.
#
# Run:  bash rescue-outage-ticket.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rescue-outage-ticket.sh
. "${HERE}/rescue-outage-ticket.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2' want '$3')"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rrot.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

export RR_OUTAGE_DATE="2026-07-05"
CAP="$WORK/posts.jsonl"
export RR_OUTAGE_POST_CMD="cat >> '$CAP'"

# jget <file> <lineNo> <jsonpath-expr> — pull a field from the Nth captured POST.
jget() {
  node -e '
    const fs=require("fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
    const obj=JSON.parse(lines[Number(process.argv[2])-1]);
    const v=process.argv[3].split(".").reduce((o,k)=>o==null?o:o[k],obj);
    process.stdout.write(v==null?"":String(v));
  ' "$1" "$2" "$3"
}

# --- slug + deterministic ticket id ----------------------------------------
eq "slug lowercases + dashes"      "$(rr_outage_slug 'Acme Co')"         "acme-co"
eq "slug strips junk + collapses"  "$(rr_outage_slug '  Gateway__Down!! ')" "gateway-down"
eq "ticket id is <client>-<class>-<date>" \
   "$(rr_outage_ticket_id 'Acme Co' 'gateway-down')" "acme-co-gateway-down-2026-07-05"
eq "ticket id falls back to unknown" \
   "$(rr_outage_ticket_id '' '')" "unknown-unknown-2026-07-05"

# --- escalate (UNFIXED stays OPEN) -----------------------------------------
: > "$CAP"
rr_outage_escalate "Acme Co" "gateway-down" "box unreachable" "kickstart; probe" "still down"
eq "escalate action"        "$(jget "$CAP" 1 action)"        "escalate"
eq "escalate ticketId"      "$(jget "$CAP" 1 ticketId)"      "acme-co-gateway-down-2026-07-05"
eq "escalate clientName"    "$(jget "$CAP" 1 clientName)"    "Acme Co"
eq "escalate failureClass"  "$(jget "$CAP" 1 failureClass)"  "gateway-down"
eq "escalate problem"       "$(jget "$CAP" 1 problem)"       "box unreachable"
eq "escalate alreadyTried"  "$(jget "$CAP" 1 alreadyTried)"  "kickstart; probe"
eq "escalate remediate-outcome" "$(jget "$CAP" 1 remediate-outcome)" "still down"
eq "escalate source pathB"  "$(jget "$CAP" 1 source)"        "pathB"
eq "escalate has NO statusPrefix" "$(jget "$CAP" 1 statusPrefix)" ""

# --- answer (FIXED resolves with statusPrefix fixed:) ----------------------
: > "$CAP"
rr_outage_answer_fixed "Acme Co" "gateway-down" "box unreachable" "tunnel restarted"
eq "answer action"        "$(jget "$CAP" 1 action)"        "answer"
eq "answer statusPrefix"  "$(jget "$CAP" 1 statusPrefix)"  "fixed:"
eq "answer ticketId same as escalate" \
   "$(jget "$CAP" 1 ticketId)" "acme-co-gateway-down-2026-07-05"
eq "answer carries the fix outcome" "$(jget "$CAP" 1 answer)" "tunnel restarted"

# --- report dispatcher routing ---------------------------------------------
: > "$CAP"
rr_outage_report "Acme Co" "cron" "cron drift" "reregister" "reregistered ok" fixed
eq "report fixed -> answer" "$(jget "$CAP" 1 action)" "answer"
: > "$CAP"
rr_outage_report "Acme Co" "cron" "cron drift" "reregister" "still failing" open
eq "report open -> escalate" "$(jget "$CAP" 1 action)" "escalate"

# --- robust JSON escaping (quotes / newline can't break the payload) --------
: > "$CAP"
rr_outage_escalate "Acme Co" "agent-error" $'he said "boom"\nline2' "tried \\ stuff" "x"
eq "escaped problem round-trips exactly" \
   "$(jget "$CAP" 1 problem)" $'he said "boom"\nline2'
eq "one well-formed JSON object per POST" \
   "$(node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");let n=0;for(const x of l){JSON.parse(x);n++}process.stdout.write(String(n))' "$CAP")" \
   "1"

# --- dry-run seam prints JSON, no post cmd needed --------------------------
DRY="$(RR_OUTAGE_POST_CMD='' RR_OUTAGE_DRYRUN=1 bash -c '. "'"${HERE}"'/rescue-outage-ticket.sh"; RR_OUTAGE_DATE=2026-07-05 rr_outage_escalate A b c d e')"
eq "dry-run emits valid JSON with action=escalate" \
   "$(printf '%s' "$DRY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).action))')" \
   "escalate"

printf '\nrescue-outage-ticket.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
