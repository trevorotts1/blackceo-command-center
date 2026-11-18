#!/usr/bin/env bash
# Install Playwright browsers plus OS libraries on a CI runner without letting a
# slow apt mirror hang the job. Only the INSTALL is retried; no test is touched.
#   usage: playwright-install.sh <browser> [<browser> ...]
#   env:   BROWSER_CACHE_HIT=true when ~/.cache/ms-playwright was restored
#          PW_INSTALL_ATTEMPTS (default 3), PW_INSTALL_TIMEOUT seconds per attempt (default 300)
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: $0 <browser>..." >&2; exit 2; }
ATTEMPTS="${PW_INSTALL_ATTEMPTS:-3}"
LIMIT="${PW_INSTALL_TIMEOUT:-300}"
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

retry() {  # description, command...
  local what="$1"; shift
  local n=1
  while [ "$n" -le "$ATTEMPTS" ]; do
    echo "::group::$what (attempt $n of $ATTEMPTS)"
    if with_timeout "$LIMIT" "$@"; then echo "::endgroup::"; return 0; fi
    echo "::endgroup::"
    echo "::warning::$what failed or timed out after ${LIMIT}s (attempt $n of $ATTEMPTS)"
    n=$((n + 1)); sleep "${PW_RETRY_SLEEP:-15}"
  done
  return 1
}

# OS libraries are not cached by the browser cache, so they are always installed.
retry "playwright install-deps $*" npx playwright install-deps "$@" || exit 1
# Browser binaries: a cache hit makes this a quick version check, no download.
retry "playwright install $*" npx playwright install "$@" || exit 1

ELAPSED=$(( $(date +%s) - START ))
echo "playwright-install: ${ELAPSED}s (browser cache hit: ${BROWSER_CACHE_HIT:-false})"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "Playwright install: ${ELAPSED}s, browser cache hit: ${BROWSER_CACHE_HIT:-false}" >> "$GITHUB_STEP_SUMMARY"
exit 0
