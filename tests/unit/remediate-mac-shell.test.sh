#!/usr/bin/env bash
# remediate.sh per-box Mac shell comes from private config ($MAC_SHELLS_CONF),
# never from a hardcoded box name. Uses the zero-SSH dry-run planner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="$ROOT/fleet-heartbeat/scripts/remediate.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf '# comment\n\nrescue-bash-box* bash\n' > "$T/mac-shells.conf"
fail=0
plan() { # <conf> <container>
  MAC_SHELLS_CONF="$1" REMEDIATE_DRY_RUN=1 REMEDIATE_FORCE_CLASS=mac-config-invalid \
    bash "$S" c p u "$2" v g s mac-tunnel 2>"$T/err" | sed -n 's/^tried=\[DRY-RUN\] \([a-z]*\) -lc.*/\1/p'
}
check() { # <want> <got> <label>
  if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: want $1 got '$2'"; fail=1; fi
}
check bash "$(plan "$T/mac-shells.conf" rescue-bash-box.zerohumanworkforce.com)" "listed box uses its shell"
check zsh  "$(plan "$T/mac-shells.conf" rescue-other.zerohumanworkforce.com)"    "unlisted box defaults to zsh"
check zsh  "$(plan "$T/missing.conf"    rescue-bash-box.zerohumanworkforce.com)" "missing config falls back to zsh"
if grep -q "WARN: per-box shell config missing" "$T/err"; then echo "ok   missing config is logged"; else echo "FAIL missing config not logged"; fail=1; fi
exit "$fail"
