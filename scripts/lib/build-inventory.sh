#!/usr/bin/env bash
# scripts/lib/build-inventory.sh — PRES-046 canonical build-content inventory.
#
# ONE canonical content inventory shared by build (atomic-deploy.sh), startup
# (cc-start.sh), health (cc-health-check.sh) and the update path (update.sh
# degraded fallback). Fixes the mtime-trust defect: restored mtimes (git pull
# re-stamps, cp-r rollback re-copies) could make OLDER code look CURRENT.
#
# What it does:
#   * Hashes SORTED relative paths plus the CONTENTS of every compile-affecting
#     input (src/, public/, config/, package.json, package-lock.json,
#     next.config.*, tsconfig.json, tailwind.config.ts, postcss.config.mjs,
#     middleware.ts) into one deterministic INVENTORY DIGEST. Content, never
#     mtime, is the freshness oracle.
#   * Records SOURCE SHA plus a DIRTY-CONTENT digest (git diff HEAD + untracked
#     listing) and a SANITIZED build-config digest (package name/version,
#     build script, node runtime — never secrets) and a BUILD_ID.
#   * Writes an immutable per-artifact MANIFEST (build-inventory.json) into the
#     build output BEFORE the atomic swap, so the manifest travels with the
#     artifact through cp-r rollback and can always be re-verified.
#
# Manifest shape (flat, one string key per line — deliberately sed-extractable
# without jq; every value quoted so a single extractor serves all fields):
#   {
#     "manifest_version": "1",
#     "built_at": "<ISO-8601>",
#     "source_sha": "<git HEAD sha or non-git sentinel>",
#     "dirty_digest": "<sha256 of git diff HEAD + untracked listing>",
#     "inventory_digest": "<sha256 over sorted 'sha256  relpath' lines>",
#     "inventory_inputs_digest": "<sha256 over the sorted relative-path LIST itself>",
#     "build_config_digest": "<sanitized, secret-free>",
#     "build_id": "<.next/BUILD_ID contents>",
#     "build_started_epoch": "<seconds>",
#     "build_finished_epoch": "<seconds>",
#     "node_runtime": "<node -v output or unknown>"
#   }
#
# inventory_inputs_digest is the OBSOLESCENCE GUARD: it pins WHICH input list
# the recorded inventory was computed over. If the canonical input set changes
# (a new compile-affecting config file appears, or the canonical list itself
# is extended in a later release), a manifest whose list digest no longer
# matches the current list verifies as OBSOLETE_INVENTORY — an exact failure,
# never a silent pass — because the recorded inventory no longer covers what
# compiles today. A manifest missing the field outright (pre-2026-09 format)
# is MANIFEST_INVALID.
#
# Deliberate-rollback receipt (transaction-bound, written by atomic-deploy.sh
# at $APP_DIR/.deploy-rollback-state.json):
#   {
#     "receipt_version": "1",
#     "type": "deploy-rollback",
#     "rolled_back_to_inventory_digest": "<approved prior artifact>",
#     "rolled_back_to_build_id": "<BUILD_ID of the prior artifact, if attested>",
#     "failed_target_inventory_digest": "<content that failed health>",
#     "failed_target_build_id": "<BUILD_ID of the failed target>",
#     "reason": "<why>",
#     "pending_repair": "true",
#     "timestamp": "<ISO-8601>",
#     "recovery": "<obligation text>"
#   }
# An arbitrary marker alone never authorizes stale code: cc-start.sh accepts a
# mismatch ONLY when the receipt's rolled_back_to digest matches the artifact
# being served AND its failed_target digest matches the current source tree —
# i.e. the receipt names exactly this prior artifact and exactly this failed
# target. There is NO loose stale-bypass flag.
#
# Receipt VERDICTS (printed by _ccbi_verify_rollback_receipt):
#   RECEIPT_OK           — receipt binds exactly (served artifact, current source);
#                          the mismatch is an acknowledged deliberate rollback.
#   RECEIPT_STALE        — receipt exists but binds some OTHER artifact/target
#                          pair: it cannot waive THIS mismatch. Exact refusal.
#   RECEIPT_INVALID      — missing required fields, wrong type/version, or
#                          pending_repair not "true": never waives anything.
#                          A tampered/stale/foreign marker is INVALID, not OK.
#
# CLI (used by cc-start.sh, deep-checks and tests):
#   bash scripts/lib/build-inventory.sh --digest  <app_dir>   # print inventory digest
#   bash scripts/lib/build-inventory.sh --inputs-digest <app_dir>  # digest of the input LIST (obsolescence guard)
#   bash scripts/lib/build-inventory.sh --verify  <app_dir>   # one-line JSON verdict; exit 0 verified, 1 mismatch, 2 manifest missing, 3 manifest invalid, 4 error, 5 obsolete inventory
#   bash scripts/lib/build-inventory.sh --verify-rollback <app_dir> <served_next_dir> <current_source_inv>  # receipt verdict line; exit 0 RECEIPT_OK, 1 otherwise
#   bash scripts/lib/build-inventory.sh --manifest <app_dir> <out_dir> <build_id> <started_epoch>
#
# Bash 3.2 compatible (cc-start.sh runs under macOS /usr/bin/env bash). No
# associative arrays, no mapfile, no ${var,,}.

# ── sha256 primitives (portable: GNU sha256sum, macOS shasum) ────────────────
# NO python3 fallback: a stubbed/shadowed python3 (CI fixture, minimal PATH,
# container) would silently return garbage or nothing and the digest would
# either fail closed (good) or — worse — hash empty input to a constant that
# could pass as a stable digest. sha256sum and shasum are both hard
# requirements of the deploy path already; if neither exists the inventory
# refuses to compute and every consumer fails loudly (PRES-046 fail-closed).
_ccbi_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    return 9
  fi
}

_ccbi_sha256_file() {
  # $1 = file path; prints hex digest; returns non-zero on unreadable file.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  else
    return 9
  fi
}

# ── inventory inputs ─────────────────────────────────────────────────────────
# Canonical compile-affecting input set. Shared with the onboarding freshness
# helper's input list (src public config + lockfile + ts/build configs) so
# build, startup, health and onboarding refresh all answer the same question.
# package-lock.json is content-hashed → dependency identity. The sanitized
# build-config digest covers runtime identity (node version) — see below.
_CCBI_TOPLEVEL_INPUTS="src public config package.json package-lock.json next.config.mjs next.config.js next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs middleware.ts"

# _ccbi_inventory_relpaths <dir> — print \n-separated, LC_ALL=C-sorted relative
# paths of every compile-affecting input file. Deterministic across machines.
_ccbi_inventory_relpaths() {
  local dir="$1"
  (
    cd "$dir" 2>/dev/null || exit 9
    {
      local p
      # Toplevel inputs: FILES only (directories are enumerated by the find
      # below; hashing a directory path would fail the whole digest). The `if`
      # form (not `[[ ]] &&`) keeps the loop's exit status 0 under `set -e/-o
      # pipefail` when the LAST candidate is absent — a bare `[[ ]] && cmd`
      # makes the whole pipeline return 1 and the caller would read a
      # successful enumeration as a failure.
      for p in $_CCBI_TOPLEVEL_INPUTS; do
        if [[ -f "$p" ]]; then printf '%s\0' "$p"; fi
      done
      # `|| true` on the find: a MISSING src/public/config directory makes find
      # exit 1 ("No such file or directory" on the absent operand). Under
      # `set -o pipefail` that would fail the whole enumeration even though
      # the present directories enumerated fine. Partial presence is normal
      # (a bare fixture has only src/); absent EVERYWHERE yields an empty
      # stream which still hashes deterministically.
      { find src -type f -print0 2>/dev/null || true; } \
        && { find public -type f -print0 2>/dev/null || true; } \
        && { find config -type f -print0 2>/dev/null || true; } || true
    } | LC_ALL=C sort -z -u | tr '\0' '\n'
  )
}

# _ccbi_inventory_digest <dir> — deterministic content digest over the sorted
# inventory: sha256 of the stream of "<sha256>  <relpath>" lines.
#
# Hashing strategy (deliberate): a pure per-file loop over _ccbi_sha256_file —
# one external hash process per file, NO python3 dependency. The earlier batched
# python3 one-shot broke every harness that stubs python3 (the B.2 fixture
# stub drains stdin and exits 0, silently yielding an empty digest — exactly
# the kind of false-attestation this unit exists to kill). Hash tools (sha256sum
# / shasum) are hard requirements of atomic-deploy.sh anyway; python3 is NOT a
# hashing dependency here anymore. A few thousand files hash in seconds, which
# is acceptable for a deploy step.
_ccbi_inventory_digest() {
  local dir="$1" tmp rc=0 p d
  tmp="$(mktemp "${TMPDIR:-/tmp}/ccbi-inv-XXXXXX")" || return 4
  (
    cd "$dir" 2>/dev/null || exit 9
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      d="$(_ccbi_sha256_file "$p")" || exit 9
      [[ -z "$d" ]] && exit 9
      printf '%s  %s\n' "$d" "$p"
    done < <(_ccbi_inventory_relpaths .)
  ) > "$tmp" 2>/dev/null || rc=$?
  if [[ "$rc" -ne 0 ]]; then rm -f "$tmp"; return 4; fi
  _ccbi_sha256_stdin < "$tmp"
  rm -f "$tmp"
}

# _ccbi_inventory_inputs_digest <dir> — digest of the RELATIVE-PATH LIST itself
# (one "<relpath>\n" per line, LC_ALL=C order). Pins WHICH inputs the inventory
# covers, independent of their contents: if a new compile-affecting file
# appears or the canonical list changes, manifests computed over the old list
# verify as OBSOLETE_INVENTORY rather than silently passing. The while-read
# normalizer uses the `if` form: a bare `[[ ]] &&` as the last loop command
# makes the pipeline exit 1 under `set -o pipefail` even on success.
_ccbi_inventory_inputs_digest() {
  local dir="$1"
  (
    cd "$dir" 2>/dev/null || exit 9
    _ccbi_inventory_relpaths . | while IFS= read -r p; do
      if [[ -n "$p" ]]; then printf '%s\n' "$p"; fi
    done
  ) | _ccbi_sha256_stdin
}

# ── git identity ─────────────────────────────────────────────────────────────
_ccbi_git_head() {
  git -C "$1" rev-parse HEAD 2>/dev/null || printf 'non-git\n'
}

# _ccbi_dirty_digest <dir> — sha256 over (git diff HEAD output + untracked
# file listing). A clean tree hashes the empty stream to a stable constant;
# ANY tracked modification or untracked new file changes the digest. This is
# the dirty-content proof that a git SHA alone cannot provide.
_ccbi_dirty_digest() {
  local dir="$1"
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    {
      git -C "$dir" diff HEAD 2>/dev/null
      git -C "$dir" ls-files --others --exclude-standard 2>/dev/null
    } | _ccbi_sha256_stdin
  else
    printf 'non-git\n' | _ccbi_sha256_stdin
  fi
}

# ── sanitized build-config digest (NEVER includes secrets) ───────────────────
# Only non-secret identity fields: package name, version, build script, node
# runtime. Dependency CONTENT identity comes from package-lock.json inside the
# inventory digest — this digest is the sanitized build CONFIGURATION record.
_ccbi_build_config_digest() {
  local dir="$1"
  local pkg="$dir/package.json"
  local node_v="unknown"
  command -v node >/dev/null 2>&1 && node_v="$(node --version 2>/dev/null || printf 'unknown')"
  {
    printf 'pkg_name=';    sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" 2>/dev/null | head -1
    printf 'pkg_version='; sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" 2>/dev/null | head -1
    printf 'build_script='; sed -n 's/.*"build"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" 2>/dev/null | head -1
    printf 'node_runtime=%s\n' "$node_v"
  } | _ccbi_sha256_stdin
}

# ── flat-JSON field extraction (manifest/receipt — no jq dependency) ─────────
_ccbi_json_field() {
  # $1 = file, $2 = key; prints first quoted value; empty if absent.
  [[ -f "$1" ]] || return 1
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -1
}

# ── atomic manifest write ────────────────────────────────────────────────────
# _ccbi_write_manifest <app_dir> <out_dir> <build_id> <build_started_epoch>
# Writes <out_dir>/build-inventory.json via tmp+mv (atomic within the build
# output), then chmod 444 (write-once). The manifest MUST be written BEFORE the
# build output is swapped into .next, so it always travels with the artifact.
_ccbi_write_manifest() {
  local app_dir="$1" out_dir="$2" build_id="$3" started="$4"
  local mf="$out_dir/build-inventory.json" tmpf="$out_dir/.build-inventory.json.tmp.$$"
  [[ -d "$out_dir" ]] || return 4
  local finished built_at source_sha dirty inv inv_in cfg node_v
  finished="$(date +%s)"
  built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')"
  source_sha="$(_ccbi_git_head "$app_dir")"
  dirty="$(_ccbi_dirty_digest "$app_dir")"     || return 4
  inv="$(_ccbi_inventory_digest "$app_dir")"   || return 4
  inv_in="$(_ccbi_inventory_inputs_digest "$app_dir")" || return 4
  cfg="$(_ccbi_build_config_digest "$app_dir")" || return 4
  node_v="unknown"
  command -v node >/dev/null 2>&1 && node_v="$(node --version 2>/dev/null || printf 'unknown')"
  cat > "$tmpf" <<EOF
{
  "manifest_version": "1",
  "built_at": "$built_at",
  "source_sha": "$source_sha",
  "dirty_digest": "$dirty",
  "inventory_digest": "$inv",
  "inventory_inputs_digest": "$inv_in",
  "build_config_digest": "$cfg",
  "build_id": "$build_id",
  "build_started_epoch": "$started",
  "build_finished_epoch": "$finished",
  "node_runtime": "$node_v"
}
EOF
  mv -f "$tmpf" "$mf" || { rm -f "$tmpf"; return 4; }
  chmod 444 "$mf" 2>/dev/null || true
  return 0
}

# ── atomic receipt write (rollback state) ────────────────────────────────────
# _ccbi_write_rollback_state <app_dir> <rolled_back_to_inv> <failed_target_inv> \
#                            <failed_target_build_id> <reason>
_ccbi_write_rollback_state() {
  local app_dir="$1" prior_inv="$2" target_inv="$3" target_bid="$4" reason="$5"
  local out="$app_dir/.deploy-rollback-state.json"
  local tmpf="$app_dir/.deploy-rollback-state.json.tmp.$$"
  local prior_bid
  # Bind the prior artifact's BUILD_ID too, when its manifest attests one —
  # the receipt then names the prior artifact by BOTH content and build id.
  prior_bid="$(_ccbi_json_field "$app_dir/.next/build-inventory.json" build_id 2>/dev/null || true)"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')"
  cat > "$tmpf" <<EOF
{
  "receipt_version": "1",
  "type": "deploy-rollback",
  "rolled_back_to_inventory_digest": "$prior_inv",
  "rolled_back_to_build_id": "$prior_bid",
  "failed_target_inventory_digest": "$target_inv",
  "failed_target_build_id": "$target_bid",
  "reason": "$reason",
  "pending_repair": "true",
  "timestamp": "$ts",
  "recovery": "Rebuild and deploy with bash scripts/atomic-deploy.sh. This state clears only when a verified GREEN deploy of THIS failed target content succeeds."
}
EOF
  mv -f "$tmpf" "$out" || { rm -f "$tmpf"; return 4; }
  return 0
}

# ── transaction-bound receipt verification ───────────────────────────────────
# _ccbi_verify_rollback_receipt <app_dir> <served_next_dir> <current_source_inv>
#
# The receipt authorizes serving content that MISMATCHES the source tree ONLY
# when it binds EXACTLY this pair:
#   * rolled_back_to_inventory_digest == the inventory digest of the artifact
#     actually being served (read from the served artifact's OWN manifest), and
#   * failed_target_inventory_digest  == the inventory digest of the CURRENT
#     source tree (the failed target that the repair obligation points at).
# Anything else — a marker for another pair, a truncated receipt, a foreign
# JSON file, a stale receipt left after the source moved on — is a refusal:
# the mismatch stands and the startup guard fails loudly. pending_repair must
# be literally "true": a receipt that claims completion is INVALID.
#
# LEGACY-PRIOR carve-out (no loose bypass): a pre-PRES-046 artifact carries no
# manifest, so its identity cannot be re-read. atomic-deploy.sh records such a
# prior as "(unattested)" in the SAME transaction that restored it. The receipt
# then binds the pair by its failed-target digest alone — which still anchors
# it to THIS source tree: a stale unattested receipt from a different failed
# deploy fails the target check and refuses. A manifest-less artifact with a
# receipt claiming a REAL digest (not "(unattested)") is a claim/artifact
# mismatch → RECEIPT_STALE. There is no flag that waives a mismatch without a
# receipt written by the deploy transaction itself.
_ccbi_verify_rollback_receipt() {
  local app_dir="$1" served_next="$2" source_inv="$3"
  local receipt="$app_dir/.deploy-rollback-state.json"
  [[ -f "$receipt" ]] || { printf 'RECEIPT_INVALID\n'; return 3; }
  local rtype rver pending r_prior r_target served_inv
  rtype="$(_ccbi_json_field "$receipt" type)"
  rver="$(_ccbi_json_field "$receipt" receipt_version)"
  pending="$(_ccbi_json_field "$receipt" pending_repair)"
  r_prior="$(_ccbi_json_field "$receipt" rolled_back_to_inventory_digest)"
  r_target="$(_ccbi_json_field "$receipt" failed_target_inventory_digest)"
  # Structural validity: exact type/version, pending repair outstanding, and
  # BOTH binding digests present and digest-shaped ("(unattested)" allowed for
  # the prior side only).
  if [[ "$rtype" != "deploy-rollback" || "$rver" != "1" || "$pending" != "true" \
        || -z "$r_prior" || -z "$r_target" || -z "$source_inv" \
        || "${#r_target}" -lt 8 ]]; then
    printf 'RECEIPT_INVALID\n'; return 3
  fi
  if [[ "$r_prior" != "(unattested)" && "${#r_prior}" -lt 8 ]]; then
    printf 'RECEIPT_INVALID\n'; return 3
  fi
  # Binding check — served artifact identity.
  if [[ ! -f "$served_next/build-inventory.json" ]]; then
    if [[ "$r_prior" == "(unattested)" ]]; then
      : # legacy-prior carve-out: receipt written in the restoring transaction
    else
      printf 'RECEIPT_STALE\n'; return 1
    fi
  else
    served_inv="$(_ccbi_json_field "$served_next/build-inventory.json" inventory_digest)"
    if [[ -z "$served_inv" || "$served_inv" != "$r_prior" ]]; then
      printf 'RECEIPT_STALE\n'; return 1
    fi
  fi
  # Binding check — failed-target identity: the receipt must name the CURRENT
  # source tree as the failed target. A receipt left over from a different
  # failed deploy (source has moved on) is stale and cannot waive anything.
  if [[ "$r_target" != "$source_inv" ]]; then
    printf 'RECEIPT_STALE\n'; return 1
  fi
  printf 'RECEIPT_OK\n'; return 0
}

# ── verification ─────────────────────────────────────────────────────────────
# _ccbi_verify_tree_against_manifest <app_dir> <manifest_path>
# Prints one of: VERIFIED | MISMATCH | MANIFEST_MISSING | MANIFEST_INVALID |
#                OBSOLETE_INVENTORY
# and returns 0/1/2/3/5 respectively. Content-only: mtimes are irrelevant.
_ccbi_verify_tree_against_manifest() {
  local app_dir="$1" manifest="$2" current recorded recorded_inputs current_inputs
  if [[ ! -f "$manifest" ]]; then
    printf 'MANIFEST_MISSING\n'; return 2
  fi
  # Truncated/invalid manifest: required fields absent → INVALID (exact
  # failure; a corrupt manifest must never silently downgrade to mtime trust).
  recorded="$(_ccbi_json_field "$manifest" inventory_digest)"
  local bid
  bid="$(_ccbi_json_field "$manifest" build_id)"
  recorded_inputs="$(_ccbi_json_field "$manifest" inventory_inputs_digest)"
  if [[ -z "$recorded" || -z "$bid" || -z "$recorded_inputs" \
        || "$recorded" == *' '* || "${#recorded}" -lt 8 ]]; then
    printf 'MANIFEST_INVALID\n'; return 3
  fi
  # Obsolescence guard: the manifest pins the input LIST it was computed over.
  # If the canonical compile-affecting input set has changed since (new config
  # file, extended canonical list), the recorded inventory no longer covers
  # what compiles today — exact failure, never a silent pass.
  current_inputs="$(_ccbi_inventory_inputs_digest "$app_dir")" \
    || { printf 'MANIFEST_INVALID\n'; return 3; }
  if [[ "$current_inputs" != "$recorded_inputs" ]]; then
    printf 'OBSOLETE_INVENTORY\n'; return 5
  fi
  current="$(_ccbi_inventory_digest "$app_dir")" || { printf 'MANIFEST_INVALID\n'; return 3; }
  if [[ "$current" == "$recorded" ]]; then
    printf 'VERIFIED\n'; return 0
  fi
  printf 'MISMATCH\n'; return 1
}

# ── CLI surface (for deep-checks.ts and tests) ───────────────────────────────
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --digest)
      _ccbi_inventory_digest "${2:?--digest requires <app_dir>}"
      ;;
    --inputs-digest)
      _ccbi_inventory_inputs_digest "${2:?--inputs-digest requires <app_dir>}"
      ;;
    --verify)
      local_dir="${2:?--verify requires <app_dir>}"
      verdict="$(_ccbi_verify_tree_against_manifest "$local_dir" "$local_dir/.next/build-inventory.json")"
      rc=$?
      bid="$(_ccbi_json_field "$local_dir/.next/build-inventory.json" build_id)"
      printf '{"verdict":"%s","build_id":"%s"}\n' "$verdict" "$bid"
      exit "$rc"
      ;;
    --verify-rollback)
      # --verify-rollback <app_dir> <served_next_dir> <current_source_inv>
      rb_dir="${2:?--verify-rollback requires <app_dir> <served_next_dir> <current_source_inv>}"
      rb_next="${3:?}"
      rb_src_inv="${4:?}"
      verdict="$(_ccbi_verify_rollback_receipt "$rb_dir" "$rb_next" "$rb_src_inv")"
      rc=$?
      printf '{"receipt_verdict":"%s"}\n' "$verdict"
      exit "$rc"
      ;;
    --manifest)
      _ccbi_write_manifest "${2:?}" "${3:?}" "${4:?}" "${5:?}"
      ;;
    *)
      printf 'usage: build-inventory.sh --digest <dir> | --inputs-digest <dir> | --verify <dir> | --verify-rollback <app_dir> <served_next_dir> <source_inv> | --manifest <app_dir> <out_dir> <build_id> <started_epoch>\n' >&2
      exit 2
      ;;
  esac
fi
