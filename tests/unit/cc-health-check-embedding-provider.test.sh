#!/usr/bin/env bash
# A box on SOP_EMBEDDING_PROVIDER=ollama was reported "degraded" by every deploy:
# cc-health-check.sh called embedding_health.py with no --sop-active-provider, so
# the probe assumed google and counted every local row as foreign. The script now
# passes the box's provider (and, for ollama, model + dims) the way /api/health
# does. Drives the real script with a fake probe that records its arguments.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-health-emb-provider.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/app/scripts" "$WORK/bin"
cp scripts/cc-health-check.sh "$WORK/app/scripts/cc-health-check.sh"
# A healthy server (same shape as cc-health-check-loopback-host.test.sh), so the
# run reaches the embedding section.
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args=("$@"); url="${args[$((${#args[@]}-1))]}"; wval=""; head=0; out=0
for i in "${!args[@]}"; do
  case "${args[$i]}" in -w) wval="${args[$((i+1))]}" ;; -o) out=1 ;; -I) head=1 ;; esac
done
case "$url" in
  */api/health/deep) printf '%s\n{"_http_code":200}' '{"pass":true,"indeterminate":false,"timestamp":"x","checks":{"asset_manifest":{"pass":true,"detail":"ok"}},"advisory":{}}'; exit 0 ;;
  */_next/static/*) if [[ $head -eq 1 ]]; then printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'; else printf '200'; fi; exit 0 ;;
esac
if [[ $out -eq 1 ]]; then [[ "$wval" == *redirect_url* ]] && printf '200 ' || printf '200'
else printf '%s' '<html><script src="/_next/static/chunks/main-abc.js"></script></html>'; fi
FAKECURL
chmod +x "$WORK/bin/curl"
cat > "$WORK/probe.py" <<'PROBE'
import json, os, sys
open(os.environ["FAKE_LOG"], "w").write(" ".join(sys.argv[1:]))
print(json.dumps({"check": "dual_store_embedding_health", "degraded": False, "asymmetric": False}))
PROBE

run() {  # $1 = script path
  : > "$WORK/log"
  env -u SOP_EMBEDDING_PROVIDER -u CC_PUBLIC_URL -u SOP_EMBEDDING_MODEL -u SOP_EMBEDDING_DIMS \
    PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/log" EMBEDDING_HEALTH_SCRIPT="$WORK/probe.py" \
    timeout 20 bash "$1" --json-only --skip-pm2 >/dev/null 2>&1
}
S="$WORK/app/scripts/cc-health-check.sh"

# 1. ollama in the app's .env.local: provider, model and dims reach the probe.
printf 'SOP_EMBEDDING_PROVIDER=ollama\nSOP_EMBEDDING_MODEL="embeddinggemma-2:740m"\nSOP_EMBEDDING_DIMS=768\n' > "$WORK/app/.env.local"
run "$S"
grep -q -- '--sop-active-provider ollama --sop-active-model embeddinggemma-2:740m --sop-active-dims 768' "$WORK/log" \
  && ok "ollama box: probe gets provider, model and dims" || bad "ollama box: probe args were [$(cat "$WORK/log")]"

# 2. No provider set: the probe keeps its own default (no provider argument).
printf 'OTHER=1\n' > "$WORK/app/.env.local"
run "$S"
[[ -s "$WORK/log" ]] && ! grep -q -- '--sop-active-provider' "$WORK/log" \
  && ok "no provider set: no provider argument" || bad "no provider set: probe args were [$(cat "$WORK/log")]"

# 3. An unknown provider value is not passed (argparse would reject it and the probe would 'fail').
printf 'SOP_EMBEDDING_PROVIDER=bogus\n' > "$WORK/app/.env.local"
run "$S"
[[ -s "$WORK/log" ]] && ! grep -q -- '--sop-active-provider' "$WORK/log" \
  && ok "unknown provider: not passed" || bad "unknown provider: probe args were [$(cat "$WORK/log")]"

# Control: the pre-fix script never told the probe the provider.
printf 'SOP_EMBEDDING_PROVIDER=ollama\n' > "$WORK/app/.env.local"
if git show v7.6.103:scripts/cc-health-check.sh > "$WORK/app/scripts/old.sh" 2>/dev/null; then
  run "$WORK/app/scripts/old.sh"
  [[ -s "$WORK/log" ]] && ! grep -q -- '--sop-active-provider' "$WORK/log" \
    && ok "control: the v7.6.103 script omits the provider" || bad "control: v7.6.103 probe args were [$(cat "$WORK/log")]"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
