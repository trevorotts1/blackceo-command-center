#!/usr/bin/env bash
# u063-how-to-structure.test.sh
#
# Test suite for U063 — Per-agent tool how-to guides.
#
# Verifies:
#   1. Every agent (except _shared) has a how-to.md with Sections 1-5
#   2. TOOLS.md references how-to.md Section 4
#   3. No two agents have identical how-to.md content (Sections 2-4 differ)
#   4. how-to.md files are well-formed markdown (heading present)
#   5. MUTATION PROOF: remove Section 4 from one file → RED; revert → GREEN
#
# Exit 0 = all checks pass; Exit 1 = failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_DIR="$REPO_ROOT/agents"
SHARED_TOOLS="$AGENTS_DIR/_shared/TOOLS.md"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass_count=0
fail_count=0

pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  pass_count=$((pass_count + 1))
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  fail_count=$((fail_count + 1))
}

cleanup_mutation() {
  # Restore the mutated file from original backup if it exists
  if [ -n "${MUTATED_FILE:-}" ] && [ -n "${MUTATION_BACKUP:-}" ] && [ -f "$MUTATION_BACKUP" ]; then
    cp "$MUTATION_BACKUP" "$MUTATED_FILE"
    rm -f "$MUTATION_BACKUP"
  fi
}
trap cleanup_mutation EXIT

echo "=== U063: Per-Agent how-to.md Structure Tests ==="
echo ""

# ── Test 1: Every agent dir (except _shared) has a how-to.md ──
echo "--- Test 1: All agents have how-to.md ---"
agent_dirs=$(find "$AGENTS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '_shared' ! -name 'node_modules' | sort)
agent_count=0
missing_howto=""

for agent_dir in $agent_dirs; do
  agent_count=$((agent_count + 1))
  agent_name=$(basename "$agent_dir")
  howto_file="$agent_dir/how-to.md"
  if [ ! -f "$howto_file" ]; then
    missing_howto="$missing_howto $agent_name"
  fi
done

if [ -z "$missing_howto" ]; then
  pass "All $agent_count agents have how-to.md files"
else
  fail "Missing how-to.md in: $missing_howto"
fi

# ── Test 2: Every how-to.md has Sections 1-5 ──
echo "--- Test 2: All how-to.md files have Sections 1-5 ---"
sections="Section 1 Section 2 Section 3 Section 4 Section 5"

for agent_dir in $agent_dirs; do
  agent_name=$(basename "$agent_dir")
  howto_file="$agent_dir/how-to.md"

  for section in $sections; do
    if ! grep -q "$section" "$howto_file"; then
      fail "$agent_name: Missing $section"
    fi
  done
done
pass "All agents have Sections 1-5 in how-to.md"

# ── Test 3: TOOLS.md references Section 4 ──
echo "--- Test 3: TOOLS.md references how-to.md Section 4 ---"
if grep -q "how-to.md.*Section 4\|Section 4.*how-to.md" "$SHARED_TOOLS"; then
  if grep -q '"Tools & Integrations"' "$SHARED_TOOLS"; then
    pass "TOOLS.md references how-to.md Section 4 ('Tools & Integrations')"
  else
    fail "TOOLS.md references Section 4 but missing 'Tools & Integrations' label"
  fi
else
  fail "TOOLS.md does not reference how-to.md Section 4"
fi

# ── Test 4: No two agents have identical how-to.md content ──
echo "--- Test 4: Per-agent differentiation (Sections 2-4 unique) ---"
# Extract Sections 2-4 from each how-to.md, compare pairwise
# Use a temp file to store hashes
hash_file=$(mktemp /tmp/u063-hashes.XXXXXX)
trap "rm -f $hash_file; cleanup_mutation" EXIT

for agent_dir in $agent_dirs; do
  agent_name=$(basename "$agent_dir")
  howto_file="$agent_dir/how-to.md"
  # Extract content between "## Section 2" and "## Section 5" (exclusive of Section 5 heading)
  # Use awk to extract lines between patterns, strip last line (Section 5 header)
  content_hash=$(awk '/^## Section 2/{flag=1; next} /^## Section 5/{flag=0; next} flag' "$howto_file" | md5 -q 2>/dev/null || awk '/^## Section 2/{flag=1; next} /^## Section 5/{flag=0; next} flag' "$howto_file" | md5sum | cut -d' ' -f1)
  echo "$content_hash $agent_name" >> "$hash_file"
done

# Collect all unique hashes and check for duplicates
declare -A hash_agents
while read -r hash agent; do
  if [ -z "${hash_agents[$hash]:-}" ]; then
    hash_agents["$hash"]="$agent"
  else
    hash_agents["$hash"]="${hash_agents[$hash]} $agent"
  fi
done < "$hash_file"

duplicate_found=false
for hash in "${!hash_agents[@]}"; do
  agents_with_hash="${hash_agents[$hash]}"
  count=$(echo "$agents_with_hash" | wc -w | tr -d ' ')
  if [ "$count" -gt 1 ]; then
    fail "Identical Sections 2-4 content for: $agents_with_hash"
    duplicate_found=true
  fi
done

if [ "$duplicate_found" = false ]; then
  pass "All $agent_count agents have unique Sections 2-4 content"
fi

# ── Test 5: how-to.md has h1 heading ──
echo "--- Test 5: Well-formed markdown (h1 heading present) ---"
for agent_dir in $agent_dirs; do
  agent_name=$(basename "$agent_dir")
  howto_file="$agent_dir/how-to.md"
  if ! head -1 "$howto_file" | grep -q "^# "; then
    fail "$agent_name: Missing h1 heading on line 1"
  fi
done
pass "All how-to.md files have h1 headings"

# ── MUTATION PROOF ──
echo ""
echo "=== MUTATION PROOF ==="
echo "--- Mutate: Remove Section 4 from one how-to.md → expect RED ---"

# Pick a file to mutate (first agent directory)
first_agent_dir=$(echo "$agent_dirs" | head -1)
mutated_file="$first_agent_dir/how-to.md"
mutation_backup=$(mktemp /tmp/u063-mutation-backup.XXXXXX)
cp "$mutated_file" "$mutation_backup"
MUTATED_FILE="$mutated_file"
MUTATION_BACKUP="$mutation_backup"

# Remove Section 4 block: delete from "## Section 4" up to (but not including) "## Section 5"
awk 'BEGIN{skip=0} /^## Section 4/{skip=1; next} /^## Section 5/{skip=0} !skip' "$mutation_backup" > "$mutated_file"

# Now count how many agents still have Section 4
section4_count=0
for agent_dir in $agent_dirs; do
  howto_file="$agent_dir/how-to.md"
  if grep -q "Section 4" "$howto_file"; then
    section4_count=$((section4_count + 1))
  fi
done

expected_no_section4=$((agent_count - 1))
if [ "$section4_count" -eq "$expected_no_section4" ]; then
  pass "MUTATION RED: Section 4 removed from $(basename "$first_agent_dir") ($section4_count of $agent_count agents have Section 4)"
else
  fail "MUTATION expected $expected_no_section4 agents with Section 4, got $section4_count"
fi

# Verify TOOLS.md still references Section 4 (reference integrity)
if grep -q "how-to.md.*Section 4\|Section 4.*how-to.md" "$SHARED_TOOLS"; then
  pass "MUTATION: TOOLS.md Section 4 reference intact (reference still valid for other agents)"
else
  fail "MUTATION: TOOLS.md lost Section 4 reference"
fi

# ── REVERT ──
echo "--- Revert: Restore Section 4 → expect GREEN ---"
cp "$mutation_backup" "$mutated_file"
rm -f "$mutation_backup"
MUTATED_FILE=""
MUTATION_BACKUP=""

# Verify all agents have Section 4 again
section4_count=0
for agent_dir in $agent_dirs; do
  howto_file="$agent_dir/how-to.md"
  if grep -q "Section 4" "$howto_file"; then
    section4_count=$((section4_count + 1))
  fi
done

if [ "$section4_count" -eq "$agent_count" ]; then
  pass "MUTATION GREEN: Section 4 restored — all $agent_count agents have Section 4"
else
  fail "MUTATION revert failed: $section4_count of $agent_count agents have Section 4"
fi

# ── SUMMARY ──
echo ""
echo "=== SUMMARY ==="
echo -e "Passed: ${GREEN}$pass_count${NC}"
echo -e "Failed: ${RED}$fail_count${NC}"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi

exit 0
