#!/usr/bin/env bash
#
# pm2-version-banner-parse.test.sh
#
# THE DEFECT: a pm2 CLI that differs from the running daemon prints
#   >>>> In-memory PM2 is out-of-date, do:
#   >>>> $ pm2 update
# on STDOUT before the app list. Every reader json.loads'ed the whole output:
# the health check read "no pm2 app for target", exited 1, and atomic-deploy
# rolled back a healthy Command Center (a 14-minute outage on a client box).
#
# PROVES (banner-prefixed list parses at every reader; the plain list is the control):
#   A0  control: pm2-analyze-cc.py on the plain list -> app_count 1 (passes on both trees).
#   A1  pm2-analyze-cc.py on banner + "[PM2]" line + list -> app_count 1, mismatch flagged.
#   B1  pm2-port-zombies.py --resolve-name reads the running CC name past the banner.
#   C1  cc-health-check.sh: HTTP down, the CC app is listed as stopped behind the
#       banner -> definitive RED "stopped" (the old parse saw nothing: UNKNOWN).
#
# Run: bash tests/unit/pm2-version-banner-parse.test.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pm2-banner.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"

list() {  # list STATUS -> one CC app on $PORT
  printf '[{"name":"cc-custom","pm_id":0,"pm2_env":{"name":"cc-custom","status":"%s","args":"scripts/cc-start.sh --port %s","pm_cwd":"%s"}}]' "$1" "$PORT" "$WORK/app"
}
BANNER=$'>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\nIn memory PM2 version: 5.3.0\nLocal PM2 version: 6.0.8\n\n[PM2] Spawning PM2 daemon with pm2_home=/tmp/x\n'

analyze() { python3 -s "$REPO_ROOT/scripts/pm2-analyze-cc.py" --port "$PORT" --app-name cc-custom; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1'))"; }

OUT="$(list online | analyze)"
[[ "$(printf '%s' "$OUT" | field app_count)" == "1" ]] \
  && ok "A0 control: plain list -> app_count 1" || bad "A0: $OUT"

OUT="$( { printf '%s' "$BANNER"; list online; } | analyze)"
[[ "$(printf '%s' "$OUT" | field app_count)" == "1" ]] && ok "A1: banner-prefixed list -> app_count 1" || bad "A1: $OUT"
[[ "$(printf '%s' "$OUT" | field pm2_version_mismatch)" == "True" ]] && ok "A1: the version mismatch is reported" || bad "A1 mismatch: $OUT"

NAME="$( { printf '%s' "$BANNER"; list online; } | python3 -s "$REPO_ROOT/scripts/lib/pm2-port-zombies.py" --resolve-name "$PORT" blackceo-command-center 2>/dev/null)"
[[ "$NAME" == "cc-custom" ]] && ok "B1: the port's running CC name resolves past the banner" || bad "B1: got '$NAME'"

mkdir -p "$WORK/bin" "$WORK/app/scripts"
cp "$REPO_ROOT/scripts/cc-health-check.sh" "$WORK/app/scripts/"
cp -R "$REPO_ROOT/scripts/lib" "$WORK/app/scripts/"
cp "$REPO_ROOT/scripts/pm2-analyze-cc.py" "$WORK/app/scripts/"
cat > "$WORK/bin/pm2" <<FAKEPM2
#!/usr/bin/env bash
if [ "\$1" = jlist ]; then printf '%s' "\$FAKE_BANNER"; printf '%s' "\$FAKE_LIST"; fi
exit 0
FAKEPM2
chmod +x "$WORK/bin/pm2"
OUT="$(FAKE_BANNER="$BANNER" FAKE_LIST="$(list stopped)" PATH="$WORK/bin:$PATH" \
  bash "$WORK/app/scripts/cc-health-check.sh" --port "$PORT" --app-name cc-custom --json-only --canonical-dir "$WORK/app" 2>/dev/null)"; RC=$?
[[ $RC -eq 1 && "$OUT" == *'"service_status":"stopped"'* ]] \
  && ok "C1: health check reads the stopped CC app past the banner (definitive RED)" || bad "C1: rc=$RC $OUT"

echo ""
printf '[pm2-version-banner-parse] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
