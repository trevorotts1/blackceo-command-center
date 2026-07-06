#!/usr/bin/env bash
# Shared configuration for the Command Center Demo Pack (sourced by reset-demo.sh
# and qc-demo.sh). No secrets here — only names, ports, and paths.

DEMO_REPO="${DEMO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DEMO_DATA_ROOT="${DEMO_DATA_ROOT:-$HOME/.command-center-demo}"
DEMO_HOME="$DEMO_DATA_ROOT/home"

INTERVIEW_PORT="${INTERVIEW_PORT:-4600}"
DASHBOARD_PORT="${DASHBOARD_PORT:-4601}"

APP_INTERVIEW="blackceo-cc-demo-interview"
APP_DASHBOARD="blackceo-cc-demo-dashboard"
APP_SIMULATOR="blackceo-cc-demo-simulator"
ECOSYSTEM="$DEMO_REPO/scripts/demo/demo.ecosystem.config.cjs"

# POSITIVE app-name allowlist — reset/qc ONLY ever act on THESE names. The real
# Command Center runs as a DIFFERENT pm2 app (e.g. cc-prod); it is never in this
# list and is therefore never stopped, deleted, or restarted by the demo tooling.
DEMO_APPS=("$APP_INTERVIEW" "$APP_DASHBOARD" "$APP_SIMULATOR")

# Names the demo tooling must NEVER act on (defensive assertion in reset-demo.sh).
FORBIDDEN_APPS=("cc-prod" "blackceo-command-center" "command-center")

# tsx runner (devDependency present after npm ci).
if [ -x "$DEMO_REPO/node_modules/.bin/tsx" ]; then
  TSX="$DEMO_REPO/node_modules/.bin/tsx"
else
  TSX="npx --yes tsx"
fi
