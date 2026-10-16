#!/usr/bin/env bash
# remediate.sh mac_ssh_run resolves the CF Access token stem from the private
# token map ($CF_TOKEN_MAP) by tunnel host and puts that token on the tunnel
# ProxyCommand. A stub ssh records its args; HOME is a temp dir so nothing
# outside it is written. Fake tokens only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="$ROOT/fleet-heartbeat/scripts/remediate.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/clawd/fleet-heartbeat"
printf '#!/bin/sh\nprintf "%%s\\n" "$@" >> "%s/ssh.args"\nexit 255\n' "$T" > "$T/bin/ssh"; chmod +x "$T/bin/ssh"
printf '{"tokens": {"rescue-box-a.zerohumanworkforce.com": "BOX_A"}}\n' > "$T/map.json"
printf 'CF_ACCESS_BOX_A_SVC_CLIENT_ID=fake-id-a\nCF_ACCESS_BOX_A_SVC_CLIENT_SECRET=fake-secret-a\n' > "$T/secrets.env"
fail=0
run() { # <container>
  : > "$T/ssh.args"
  HOME="$T/home" PATH="$T/bin:$PATH" CF_TOKEN_MAP="$T/map.json" SECRETS_ENV="$T/secrets.env" \
    CF_TUNNEL_TIMEOUT=10 bash "$S" c p u "$1" v g s mac-tunnel >/dev/null 2>"$T/err" || true
}
run rescue-box-a.zerohumanworkforce.com
if grep -q -- "--service-token-id fake-id-a --service-token-secret fake-secret-a" "$T/ssh.args"; then
  echo "ok   mapped host carries its token"; else echo "FAIL mapped host token not on ProxyCommand"; fail=1; fi
run rescue-unmapped.zerohumanworkforce.com
if grep -q "WARN: no CF token stem for rescue-unmapped" "$T/err"; then
  echo "ok   unmapped host is logged"; else echo "FAIL unmapped host not logged"; fail=1; fi
exit "$fail"
