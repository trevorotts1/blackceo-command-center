/**
 * Fixture for qc-cc.sh check-5.1 self-test.
 *
 * Contains a double-quoted claude-* model literal in a non-exempt path.
 * check_claude_literals() MUST detect this and return non-zero (FAIL).
 *
 * The original regex anchored only on single-quotes, so:
 *   grep -rE "'claude-[a-z0-9-]+'"
 * matched 0 lines here → inverted (!) was vacuously TRUE = false PASS.
 *
 * The fixed version matches all three delimiter styles (', ", `):
 *   grep -rn 'claude-' | grep -E "['\"\`]claude-[a-z0-9-]+['\"\`]"
 * which correctly detects this literal.
 *
 * Round-2 fix #5 test fixture.
 */

// This double-quoted literal MUST trigger check 5.1 FAIL.
// It is intentionally NOT in an orchestrator, anthropic connector,
// or web-agent file.
const hardcodedModel = "claude-sonnet-4-5";

export { hardcodedModel };
