#!/usr/bin/env bash
# Install Playwright browsers plus OS libraries on a CI runner without letting a
# slow apt mirror hang the job. Only the INSTALL is retried; no test is touched.
#   usage: playwright-install.sh <browser> [<browser> ...]
#   env:   BROWSER_CACHE_HIT=true when ~/.cache/ms-playwright was restored
#          PW_INSTALL_ATTEMPTS (3) and PW_INSTALL_TIMEOUT (300 s) for the browser download;
#          PW_DEPS_ATTEMPTS (5) and PW_DEPS_TIMEOUT (120 s) for the apt step
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: $0 <browser>..." >&2; exit 2; }
ATTEMPTS="${PW_INSTALL_ATTEMPTS:-3}"
LIMIT="${PW_INSTALL_TIMEOUT:-300}"
# apt downloads are resumable and keep every finished .deb, so short attempts
# lose almost nothing and cut a stalled connection off quickly.
DEPS_LIMIT="${PW_DEPS_TIMEOUT:-120}"
DEPS_ATTEMPTS="${PW_DEPS_ATTEMPTS:-5}"
START=$(date +%s)

# apt: retry each download, give up on a stalled connection quickly, IPv4 only.
if [ -d /etc/apt/apt.conf.d ] && command -v sudo >/dev/null 2>&1; then
  printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::ForceIPv4 "true";\n' \
    | sudo tee /etc/apt/apt.conf.d/99-ci-retries >/dev/null || true
fi

with_timeout() {  # $1 seconds, rest command
  local s="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi
}

# Kill an apt left running by a timed-out attempt (it would hold the dpkg lock
# and fail every later attempt), repair a half-finished dpkg, and rotate the
# Ubuntu mirror so a stalled one is not asked again.
apt_recover() {  # $1 attempt number that just failed
  command -v sudo >/dev/null 2>&1 || return 0
  sudo pkill -9 -x apt-get 2>/dev/null || true
  sudo pkill -9 -x apt 2>/dev/null || true
  sleep 2
  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
  sudo dpkg --configure -a >/dev/null 2>&1 || true
  local mirror
  case "$1" in 1) mirror="http://azure.archive.ubuntu.com/ubuntu" ;; *) mirror="http://archive.ubuntu.com/ubuntu" ;; esac
  for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
    [ -f "$f" ] && sudo sed -i -E "s#https?://[A-Za-z0-9.-]*ubuntu\.com/ubuntu/?#${mirror}#g" "$f" 2>/dev/null || true
  done
  echo "::warning::apt recovered after attempt $1; mirror now $mirror"
}

retry() {  # description, command...
  local what="$1"; shift
  local n=1 attempts="$ATTEMPTS" limit="$LIMIT"
  case "$what" in *install-deps*) attempts="$DEPS_ATTEMPTS"; limit="$DEPS_LIMIT" ;; esac
  while [ "$n" -le "$attempts" ]; do
    echo "::group::$what (attempt $n of $attempts)"
    if with_timeout "$limit" "$@"; then echo "::endgroup::"; return 0; fi
    echo "::endgroup::"
    echo "::warning::$what failed or timed out after ${limit}s (attempt $n of $attempts)"
    case "$what" in *install-deps*) apt_recover "$n" ;; esac
    n=$((n + 1)); sleep "${PW_RETRY_SLEEP:-15}"
  done
  return 1
}

# Browser binaries come from the Playwright CDN, not apt; a cache hit makes this
# a quick version check with no download.
retry "playwright install $*" npx playwright install "$@" || exit 1

# The runner image already carries most browser libraries. Only touch apt (the
# step that hangs on a slow mirror) when a real launch of every requested
# browser fails.
PROBE_JS='
  const pw = require("@playwright/test");
  (async () => {
    for (const name of process.argv.slice(1)) {
      const b = await pw[name].launch();
      await b.close();
    }
  })().then(() => process.exit(0), (e) => { console.error(String(e).split("\n")[0]); process.exit(1); });
'
if with_timeout 120 node -e "$PROBE_JS" "$@"; then
  echo "playwright-install: all requested browsers launch; OS libraries already present, skipping apt"
  APT_SKIPPED=true
else
  echo "playwright-install: a browser failed to launch, installing OS libraries"
  retry "playwright install-deps $*" npx playwright install-deps "$@" || exit 1
  APT_SKIPPED=false
fi

ELAPSED=$(( $(date +%s) - START ))
echo "playwright-install: ${ELAPSED}s (browser cache hit: ${BROWSER_CACHE_HIT:-false}, apt skipped: $APT_SKIPPED)"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "Playwright install: ${ELAPSED}s, browser cache hit: ${BROWSER_CACHE_HIT:-false}, apt skipped: $APT_SKIPPED" >> "$GITHUB_STEP_SUMMARY"
exit 0
