#!/usr/bin/env bash
# create-tunnel-token-file.test.sh (D16)
# THE DEFECT: create-tunnel.sh ran `pm2 start "cloudflared tunnel run --token $TUNNEL_TOKEN"`,
# so the bearer token landed in ~/.pm2/dump.pm2, its backups and `ps`.
# Runs the real script with fake curl/pm2/cloudflared/sleep on PATH and a temp HOME.
#   T1 pm2 got --token-file <path> and the token text appears nowhere in the pm2 argv
#   T2 the token file is mode 600 and holds the token
# Run: bash tests/unit/create-tunnel-token-file.test.sh   (CREATE_TUNNEL_SCRIPT=<path> to test another copy)
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${CREATE_TUNNEL_SCRIPT:-$REPO_ROOT/scripts/create-tunnel.sh}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
FAKE_TOKEN="FAKE-TOKEN-d16-not-a-real-credential"
cat > "$T/bin/curl" <<SH
#!/bin/bash
case "\$*" in
  *-X\ POST*) echo '{"status":"success","tunnel":"$FAKE_TOKEN","subdomain":"x.example.invalid"}' ;;
  *) echo 200 ;;
esac
SH
cat > "$T/bin/pm2" <<'SH'
#!/bin/bash
echo "pm2 $*" >> "$PM2_LOG"
SH
printf '#!/bin/bash\nexit 0\n' > "$T/bin/cloudflared"
printf '#!/bin/bash\nexit 0\n' > "$T/bin/sleep"
chmod +x "$T"/bin/*

PM2_LOG="$T/pm2.log" HOME="$T/home" PATH="$T/bin:$PATH" bash "$SRC" slug "Co" a@b.invalid >"$T/out" 2>&1
START="$(grep '^pm2 start' "$T/pm2.log" || true)"
TF="$(printf '%s' "$START" | grep -oE -e '--token-file [^ "]+' | cut -d' ' -f2)"

if [[ -n "$TF" ]] && ! grep -q -e '--token ' "$T/pm2.log"; then ok "T1 pm2 start uses --token-file"; else bad "T1 pm2 start uses --token-file ($START)"; fi
if ! grep -q "$FAKE_TOKEN" "$T/pm2.log"; then ok "T1 token text absent from pm2 argv"; else bad "T1 token text absent from pm2 argv"; fi
if [[ -n "$TF" && -f "$TF" && "$(cat "$TF")" == "$FAKE_TOKEN" ]]; then ok "T2 token file holds the token"; else bad "T2 token file holds the token"; fi
MODE="$(stat -f %Lp "$TF" 2>/dev/null || stat -c %a "$TF" 2>/dev/null)"
if [[ "$MODE" == "600" ]]; then ok "T2 token file mode 600"; else bad "T2 token file mode 600 (got $MODE)"; fi

echo "$PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]]
