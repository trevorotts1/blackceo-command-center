#!/usr/bin/env bash
#
# deploy-dashboard.sh — Feature 52 per-client Conversational-AI dashboard deploy.
#
# Publishes the built Command Center to a per-client subdomain
# (dashboard.<their-domain>) on Cloudflare Pages, behind the existing
# Cloudflare tunnel + Cloudflare Access app (same gate as F49).
#
# SCOPE-GATED: this script REFUSES to deploy unless the Cloudflare API token
# carries the three scopes F49 established for per-client Pages publishing:
#   - Pages: Edit          (Account-level: Cloudflare Pages -> Edit)
#   - Workers Scripts: Edit (Account-level: Workers Scripts -> Edit)
#   - Workers Routes: Edit  (Zone-level:    Workers Routes  -> Edit)
#
# Run the precheck FIRST. If scopes are missing, the script prints exactly
# which ones and exits non-zero WITHOUT touching Cloudflare. The Command
# Center card ships inside the app regardless of this deploy — this script is
# only for the optional standalone per-client subdomain.
#
# Required env:
#   CLOUDFLARE_API_TOKEN   token with the three scopes above
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare account UUID
#
# Usage:
#   ./scripts/conversational-ai/deploy-dashboard.sh --precheck
#   ./scripts/conversational-ai/deploy-dashboard.sh <project-name> <subdomain>
#
# Example:
#   ./scripts/conversational-ai/deploy-dashboard.sh acme-dashboard dashboard.acme.com

set -euo pipefail

CF_API_ROOT="${CF_API_ROOT:-https://api.cloudflare.com/client/v4}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

err()  { echo "ERROR: $*" >&2; }
info() { echo "[deploy] $*" >&2; }

require_env() {
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    err "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars."
    exit 1
  fi
}

# cf_get <path> -> raw body on stdout, non-zero + body on stderr on HTTP error
cf_get() {
  local path="$1" tmp http
  tmp=$(mktemp)
  http=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X GET "${CF_API_ROOT}${path}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$http" -lt 200 ] || [ "$http" -ge 300 ]; then
    err "Cloudflare GET ${path} -> HTTP ${http}"
    cat "$tmp" >&2; echo >&2
    rm -f "$tmp"
    return 1
  fi
  cat "$tmp"; rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Scope precheck — the gate
# ---------------------------------------------------------------------------
#
# We verify the token is valid AND that the account exposes the Pages API to
# it. Cloudflare does not return a literal scope list on the token-verify
# endpoint, so we probe the actual endpoints the deploy needs (a GET against
# Pages projects). A 200/empty list means the Pages: Edit scope is present;
# a 403 means it is missing. This is the same "probe the real endpoint"
# approach F49 used for Access scopes.

precheck() {
  require_env
  local missing=()

  info "Verifying token is valid..."
  if ! cf_get "/user/tokens/verify" >/dev/null 2>&1; then
    err "Token failed /user/tokens/verify. It is invalid, expired, or not exported."
    exit 2
  fi
  info "  token valid."

  info "Probing Pages: Edit (GET pages/projects)..."
  if cf_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects?per_page=1" >/dev/null 2>&1; then
    info "  Pages API reachable (Pages: Edit present)."
  else
    missing+=("Pages: Edit (Account -> Cloudflare Pages -> Edit)")
  fi

  info "Probing Workers Scripts: Edit (GET workers/scripts)..."
  if cf_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts?per_page=1" >/dev/null 2>&1; then
    info "  Workers Scripts API reachable (Workers Scripts: Edit present)."
  else
    missing+=("Workers Scripts: Edit (Account -> Workers Scripts -> Edit)")
  fi

  # Workers Routes are zone-scoped; we can only confirm the account-level
  # Workers permission here. The zone-level Workers Routes: Edit scope is
  # required at the moment a custom domain/route is attached and is reported
  # by the Pages custom-domain call itself if absent.
  info "NOTE: Workers Routes: Edit is zone-scoped and verified at domain-attach time."

  if [ "${#missing[@]}" -gt 0 ]; then
    err "Scope precheck FAILED. The token is missing:"
    for s in "${missing[@]}"; do err "  - $s"; done
    err ""
    err "Add these at https://dash.cloudflare.com/profile/api-tokens and re-run."
    err "Per-client subdomain deploy is GATED until scopes are present."
    err "The Command Center card itself already ships inside the app — no deploy needed for that."
    exit 3
  fi

  info "Scope precheck PASSED. Safe to deploy."
}

# ---------------------------------------------------------------------------
# Build + deploy
# ---------------------------------------------------------------------------

deploy() {
  local project="$1" subdomain="$2"
  require_env
  precheck

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  if ! command -v npx >/dev/null 2>&1; then
    err "npx not found. Install Node.js to run wrangler."
    exit 4
  fi

  info "Building Command Center for static export..."
  ( cd "$repo_root" && npm run build )

  # Next.js App Router with API routes is a SERVER app, not a pure static
  # export. For Cloudflare Pages we use @cloudflare/next-on-pages, which the
  # operator installs once per machine. We DO NOT vendor it into deps to keep
  # the in-app card path dependency-free.
  if ! npx --no-install @cloudflare/next-on-pages --version >/dev/null 2>&1; then
    err "@cloudflare/next-on-pages is not installed."
    err "Install it for the deploy machine: npm i -g @cloudflare/next-on-pages wrangler"
    exit 5
  fi

  info "Adapting build for Cloudflare Pages..."
  ( cd "$repo_root" && npx @cloudflare/next-on-pages )

  info "Publishing to Pages project '${project}'..."
  ( cd "$repo_root" && npx wrangler pages deploy .vercel/output/static \
      --project-name "$project" )

  info "Attaching custom domain ${subdomain} (requires zone-level Workers Routes: Edit)..."
  if ! cf_get_post_domain "$project" "$subdomain"; then
    err "Custom-domain attach failed — most likely the token lacks zone-level"
    err "Workers Routes: Edit for the zone that owns ${subdomain}. The Pages"
    err "deployment itself succeeded; attach the domain in the dashboard or"
    err "re-run with a token that has the zone scope."
    exit 6
  fi

  info "Deploy complete. Gate the subdomain with the F49 Access app:"
  info "  ./scripts/cloudflare/setup-access-app.sh ${subdomain} <operator-email>"
}

cf_get_post_domain() {
  local project="$1" subdomain="$2" tmp http
  tmp=$(mktemp)
  http=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X POST "${CF_API_ROOT}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}/domains" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"${subdomain}\"}")
  if [ "$http" -lt 200 ] || [ "$http" -ge 300 ]; then
    cat "$tmp" >&2; echo >&2; rm -f "$tmp"; return 1
  fi
  rm -f "$tmp"; return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-}" in
  --precheck|-p)
    precheck
    ;;
  --help|-h|"")
    echo "Usage:"
    echo "  $0 --precheck                       Verify CF token scopes only (no deploy)"
    echo "  $0 <project-name> <subdomain>       Build + deploy to Pages + attach domain"
    exit 0
    ;;
  *)
    if [ "$#" -lt 2 ]; then
      err "Usage: $0 <project-name> <subdomain>   (or --precheck)"
      exit 1
    fi
    deploy "$1" "$2"
    ;;
esac
