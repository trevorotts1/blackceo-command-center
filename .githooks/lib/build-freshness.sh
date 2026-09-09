#!/usr/bin/env bash
# .githooks/lib/build-freshness.sh — advisory build-freshness check for the
# post-commit / post-checkout Git callbacks (PRES-047).
#
# WHAT THIS IS
#   The shared decision logic behind .githooks/post-commit and
#   .githooks/post-checkout. After a Git operation it checks whether the
#   checkout's compile-affecting content has moved past the last build
#   (.next/BUILD_ID) and, if so, prints an ADVISORY pointing at the canonical
#   deploy procedure. It NEVER deploys, restarts, posts messages, or writes
#   anything outside one baseline marker under .next/ — post hooks cannot and
#   must not block a Git operation, so every path here exits 0.
#
# VALIDATOR COMPOSITION (PRES-046)
#   PRES-046 introduces a shared build-content validator. When it is present
#   this hook PREFERS it and adds nothing of its own:
#
#     1. $CC_BUILD_CONTENT_VALIDATOR          (explicit override)
#     2. <repo>/scripts/lib/build-content-validator.sh   (canonical location)
#
#   Contract expected from the shared validator (documented so PRES-046 can
#   conform; this file only consumes it):
#     exit 0   -> checkout content matches the live build  -> silent
#     exit 3   -> content mismatch; its stdout/stderr is the reason
#                 -> advisory printed, still exit 0
#     other    -> inconclusive -> fall back to the built-in check below
#
#   BUILT-IN FALLBACK (used only while the shared validator is absent):
#     The fallback is a COMMITTED-CONTENT CHANGE DETECTOR, not a full build
#     inventory (the content inventory is PRES-046's territory — this file
#     deliberately does not reimplement it). It digests the same tracked
#     source set the repo's existing staleness guard in scripts/cc-start.sh
#     uses (src/**, package.json, next.config.*) plus HEAD, and compares it to
#     a baseline recorded beside the build (.next/.cc-advisory-digest):
#
#       * no .next/BUILD_ID          -> silent (a MISSING build is not a STALE
#                                       build; cc-start.sh already fails loud
#                                       on missing builds — this hook must not
#                                       fabricate a second signal)
#       * fresh build (BUILD_ID newer
#         than the baseline file)    -> silently re-baseline to current HEAD
#       * no baseline yet            -> silently seed it (fail-open first
#                                       observation; the hook has no way to
#                                       know what the old build was built from)
#       * digest == baseline         -> silent (content unchanged — a mere
#                                       `touch` or empty commit NEVER warns)
#       * digest != baseline         -> ADVISORY (content changed since the
#                                       last observed build state), re-baseline
#
#   Both paths are content-based: advisory output happens ONLY on content
#   mismatch, never on mtime churn.
#
# SIDE-EFFECT BUDGET (asserted by tests/unit/pres-047-git-advisory-hooks.test.sh):
#   * writes: ONLY .next/.cc-advisory-digest (one line)
#   * process/network: NONE — no pm2, no curl, no ssh, no osascript, nothing
#   * exit code: ALWAYS 0

# Avoid `set -e` inheritance surprises: hooks source this file; every branch
# must return 0. Guard unset vars explicitly instead of relying on -u.
set +u +e 2>/dev/null || true

bf_repo_root() {
  # The lib file's own location is authoritative: this file lives at
  # <repo-root>/.githooks/lib/, so the repo root is dirname(this file)/../..
  # (.githooks/lib -> .githooks -> repo root). The ambient CWD is NEVER
  # trusted — Git host invocation happens to run with CWD = repo top, but a
  # manual `bash <hookpath>` (or an invocation from inside an unrelated
  # checkout, which also has a .githooks/) must not adopt a foreign repo.
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || return 1
  [ -f "$here/.githooks/lib/build-freshness.sh" ] || return 1
  printf '%s\n' "$here"
}

# 1 when this checkout is a linked worktree (git-dir != common git-dir).
bf_is_linked_worktree() {
  local gd cd_
  gd="$(git rev-parse --git-dir 2>/dev/null)" || return 1
  cd_="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$gd" ] && [ -n "$cd_" ] && [ "$gd" != "$cd_" ]
}

# Shared PRES-046 validator path, or empty when not usable.
bf_shared_validator() {
  local root="$1" cand
  cand="${CC_BUILD_CONTENT_VALIDATOR:-}"
  if [ -n "$cand" ] && [ -f "$cand" ]; then
    printf '%s\n' "$cand"
    return 0
  fi
  cand="$root/scripts/lib/build-content-validator.sh"
  if [ -f "$cand" ]; then
    printf '%s\n' "$cand"
    return 0
  fi
  return 0
}

# Digest of tracked compile-affecting content. Uses git's own object hashing
# so no external digest tool is needed (portable: macOS/Linux/CI). The INDEX
# entries (mode + blob sha per path) are the content: a commit or checkout
# moves the index only when actual content moves with it, so an empty commit
# or a bare mtime touch produces the SAME digest and stays silent.
# Git is pinned to $1 (the resolved repo root) — a hook invoked from a foreign
# CWD must read THE HOOK'S OWN repo's index, never the ambient checkout's.
bf_compile_digest() {
  local root="${1:-.}"
  git -C "$root" ls-files -s -- src package.json package-lock.json \
       next.config.js next.config.mjs next.config.ts 2>/dev/null \
    | git hash-object --stdin 2>/dev/null
}

bf_emit_advisory() {
  local hook="$1" reason="$2" root
  root="${CC_ADVISORY_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
  printf '[cc-advisory] STALE BUILD (%s): %s\n' "$hook" "$reason" 1>&2
  printf '[cc-advisory] This checkout now contains content that is NOT in the running build.\n' 1>&2
  printf '[cc-advisory] Rebuild through the canonical deploy path:\n' 1>&2
  printf '[cc-advisory]   bash scripts/atomic-deploy.sh --app-dir "%s"\n' "$root" 1>&2
  printf '[cc-advisory] Advisory only: nothing was deployed, restarted or messaged.\n' 1>&2
}

# Main entry. Args: hook name (post-commit|post-checkout), plus the hook's own
# argv (post-checkout passes prev new branch-flag; post-commit passes none).
bf_advisory_if_stale() {
  local hook="$1"; shift || true
  local root validator out rc digest base stored

  root="$(bf_repo_root)"
  [ -n "$root" ] || return 0
  export CC_ADVISORY_ROOT="$root"

  # Missing build: never advise (cc-start.sh owns the loud missing-build path).
  [ -f "$root/.next/BUILD_ID" ] || return 0

  validator="$(bf_shared_validator "$root")"
  if [ -n "$validator" ]; then
    out="$(bash "$validator" "$root" 2>&1)"
    rc=$?
    case "$rc" in
      0) return 0 ;;                       # shared validator: content matches
      3) bf_emit_advisory "$hook" "${out:-content-inventory mismatch (shared validator)}"; return 0 ;;
      *) : ;;                              # inconclusive -> built-in fallback
    esac
  fi

  digest="$(bf_compile_digest "$root")"
  [ -n "$digest" ] || return 0

  base="$root/.next/.cc-advisory-digest"
  if [ ! -f "$base" ] || [ "$root/.next/BUILD_ID" -nt "$base" ]; then
    # Fresh build (or first observation): seed/refresh the baseline silently.
    printf '%s\n' "$digest" > "$base" 2>/dev/null
    return 0
  fi

  stored="$(cat "$base" 2>/dev/null)"
  [ "$digest" = "$stored" ] && return 0

  bf_emit_advisory "$hook" \
    "tracked compile-affecting content (src/**, package.json, next.config.*) differs from the baseline recorded against the last build (.next/BUILD_ID)."
  printf '%s\n' "$digest" > "$base" 2>/dev/null
  return 0
}