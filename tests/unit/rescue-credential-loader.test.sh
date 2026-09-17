#!/usr/bin/env bash
# rescue-credential-loader.test.sh — Rescue webhook credential parser contract.
#
# All values are dummies. This test never prints a loaded value, a store path,
# or a service-home path; it compares values in shell and prints only labels.
#
# Run: bash tests/unit/rescue-credential-loader.test.sh

set -u

TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../../scripts/lib/rescue-credentials.sh
source "$TEST_ROOT/../scripts/lib/rescue-credentials.sh"

FAILURES=0
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rr-credentials.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

assert_value() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label"
  fi
}

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    pass "$label"
  else
    fail "$label"
  fi
}

write_env() {
  local contents="$1" target="$2"
  if [[ "$target" == /* ]]; then
    printf '%s\n' "$contents" > "$target"
  else
    printf '%s\n' "$contents" > "$TMP_DIR/$target"
  fi
}

# Parser cases. The expected values stay in shell variables and are never sent
# to stdout by this test.
write_env 'RESCUE_RANGERS_WEBHOOK_SECRET=dummy-unquoted' unquoted.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/unquoted.env"
assert_value 'unquoted value is parsed literally' 'dummy-unquoted' "$RESCUE_DOTENV_VALUE"

write_env "RESCUE_RANGERS_WEBHOOK_SECRET='dummy-single \$HOME \`id\` # not-comment'" single.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/single.env"
assert_value 'single-quoted value preserves special characters and hash' \
  "dummy-single \$HOME \`id\` # not-comment" "$RESCUE_DOTENV_VALUE"

write_env 'RESCUE_RANGERS_WEBHOOK_SECRET="dummy-double $(id -u 2>/dev/null || true) # not-expanded"' double.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/double.env"
assert_value 'double-quoted command substitution is never evaluated' \
  'dummy-double $(id -u 2>/dev/null || true) # not-expanded' "$RESCUE_DOTENV_VALUE"

write_env '# full-line comment
   RESCUE_RANGERS_WEBHOOK_SECRET = dummy-padded   # trailing comment
' comments.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/comments.env"
assert_value 'whitespace, padding, and trailing comments are handled' \
  'dummy-padded' "$RESCUE_DOTENV_VALUE"

write_env 'RESCUE_RANGERS_WEBHOOK_SECRET="dummy-quoted # not-comment" # real comment' quoted-comment.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/quoted-comment.env"
assert_value 'hash inside double quotes is preserved and trailing comment removed' \
  'dummy-quoted # not-comment' "$RESCUE_DOTENV_VALUE"

write_env "RESCUE_RANGERS_WEBHOOK_SECRET='dummy-single # not-comment' # real comment" single-comment.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/single-comment.env"
assert_value 'hash inside single quotes is preserved and trailing comment removed' \
  'dummy-single # not-comment' "$RESCUE_DOTENV_VALUE"

cat > "$TMP_DIR/escapes.env" <<'EOF'
RESCUE_RANGERS_WEBHOOK_SECRET="dummy \" and backslash \\ and 'quotes'"
EOF
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/escapes.env"
assert_value 'escaped quotes and backslashes remain literal' \
  "dummy \" and backslash \\ and 'quotes'" "$RESCUE_DOTENV_VALUE"

write_env 'RESCUE_RANGERS_WEBHOOK_SECRET=' empty.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/empty.env"
assert_status 'unquoted empty value is present' 0 "$?"
assert_value 'unquoted empty value is empty' '' "$RESCUE_DOTENV_VALUE"

write_env 'RESCUE_RANGERS_WEBHOOK_SECRET=""' empty-double.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/empty-double.env"
assert_status 'double-quoted empty value is present' 0 "$?"
assert_value 'double-quoted empty value is empty' '' "$RESCUE_DOTENV_VALUE"

write_env "RESCUE_RANGERS_WEBHOOK_SECRET=''" empty-single.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/empty-single.env"
assert_status 'single-quoted empty value is present' 0 "$?"
assert_value 'single-quoted empty value is empty' '' "$RESCUE_DOTENV_VALUE"

write_env 'OTHER_KEY=dummy
RESCUE_RANGERS_WEBHOOK_SECRET=dummy-first
RESCUE_RANGERS_WEBHOOK_SECRET=dummy-last
' duplicates.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/duplicates.env"
assert_value 'the last dotenv assignment wins' 'dummy-last' "$RESCUE_DOTENV_VALUE"

rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/missing.env"
assert_status 'missing file is unavailable' 1 "$?"

write_env 'OTHER_KEY=dummy-only' missing-key.env
rescue_read_dotenv_key RESCUE_RANGERS_WEBHOOK_SECRET "$TMP_DIR/missing-key.env"
assert_status 'missing key is unavailable' 1 "$?"

# Service identity and configured-root resolution.
if rescue_service_home; then
  if [[ -n "$RESCUE_SERVICE_HOME" ]]; then
    pass 'service home resolves from the current service identity'
  else
    fail 'service home resolved to an empty path'
  fi
else
  fail 'service home could not be resolved from the current service identity'
fi

(
  HOME='/definitely/not/the/service/home'
  if rescue_service_home && [[ -n "$RESCUE_SERVICE_HOME" ]]; then
    exit 0
  fi
  exit 1
)
assert_status 'service-home resolution ignores inherited HOME' 0 "$?"

mkdir -p "$TMP_DIR/root/secrets"
write_env 'RESCUE_RANGERS_WEBHOOK_SECRET=dummy-file-value' "$TMP_DIR/root/secrets/.env"
OPENCLAW_ROOT="$TMP_DIR/root" rescue_secret_store_path
assert_status 'configured OPENCLAW_ROOT resolves the store' 0 "$?"
if [[ "$RESCUE_SECRET_STORE_PATH" == "$TMP_DIR/root/secrets/.env" ]]; then
  pass 'configured store path points at the service root'
else
  fail 'configured store path does not point at the service root'
fi

# Environment precedence and end-to-end load.
(
  export RESCUE_RANGERS_WEBHOOK_SECRET='dummy-env-wins'
  export OPENCLAW_ROOT="$TMP_DIR/root"
  rescue_load_webhook_secret
  if [[ "$RESCUE_RANGERS_WEBHOOK_SECRET" == 'dummy-env-wins' ]]; then
    exit 0
  fi
  exit 1
)
assert_status 'process environment wins over the secret store' 0 "$?"

(
  export OPENCLAW_ROOT="$TMP_DIR/root"
  rescue_load_webhook_secret
  if [[ "${RESCUE_RANGERS_WEBHOOK_SECRET:-}" == 'dummy-file-value' ]]; then
    exit 0
  fi
  exit 1
)
assert_status 'secret store loads the allowlisted key without printing it' 0 "$?"

write_env 'RESCUE_RANGERS_WEBHOOK_SECRET=' "$TMP_DIR/root/secrets/.env"
(
  export OPENCLAW_ROOT="$TMP_DIR/root"
  rescue_load_webhook_secret
)
assert_status 'empty store value is reported separately and not exported' 2 "$?"

if grep -Eq '^[[:space:]]*(eval|source|\\.)[[:space:]]+' "$TEST_ROOT/../scripts/lib/rescue-credentials.sh"; then
  fail 'loader contains an evaluating shell command'
else
  pass 'loader contains no evaluating shell command'
fi

if [[ "$FAILURES" -eq 0 ]]; then
  printf 'PASS: all rescue credential loader assertions held\n'
  exit 0
fi

printf 'FAIL: %d rescue credential loader assertion(s)\n' "$FAILURES"
exit 1
