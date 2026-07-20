#!/usr/bin/env bash
# ============================================================
#  BlackCEO Command Center — Updater
#  Pulls latest from GitHub, installs deps, runs migrations.
#  DESTRUCTIVE: replaces app code in-place. Backs up first.
#
#  ENV OVERRIDES — an explicit pin ALWAYS wins over autodetection. Each of
#  these is used verbatim when set, and the corresponding autodetection is
#  skipped entirely:
#    CC_APP_DIR        Command Center checkout to update. Skips the candidate
#                      scan below. Still validated (see "Resolve install
#                      location") — a pin that is NOT a Command Center checkout
#                      is a hard error, never a silent fall-back to a guess.
#    CC_PM2_APP_NAME   pm2 process name to restart (Step 5). Wins over the
#                      live pm2-port lookup and the fleet-canonical fallback.
#    CC_PORT           Port the live app serves on (Step 5). Wins over the
#                      built-in 4000 default and is passed to atomic-deploy.
#  Pinning all three is the supported way to update a box whose layout does
#  not match a documented fleet layout.
# ============================================================

set -euo pipefail
SCRIPT_VERSION="1.2.0"
REPO_URL="https://github.com/trevorotts1/blackceo-command-center.git"
LOG_FILE="/tmp/blackceo-cc-update-$(date +%Y%m%d-%H%M%S).log"
exec 1> >(tee -a "$LOG_FILE") 2>&1

step() { echo ""; echo "━━━ $1 ━━━"; }
success() { echo "  ✓ $1"; }
warn() { echo "  ⚠ $1"; }
fatal() { echo "  ✗ ERROR: $1"; exit 1; }

# ----------------------------------------------------------
# Detect install location
# ----------------------------------------------------------
# P1-07: an explicit caller (e.g. the onboarding repo's Sunday --update-only
# path, which already knows exactly which checkout it just pulled) can pin
# the install dir directly instead of relying on autodetection — same
# CC_APP_DIR convention scripts/atomic-deploy.sh and scripts/deploy.sh
# already use, so this script honors it too rather than inventing a new name.
#
# TRAP-2 (canary, operator Mac mini): detection used to accept ANY directory
# that merely CONTAINED a package.json, and took the first candidate that hit.
# `~/projects/command-center` is first in the list and DOES exist on the
# operator box — as a non-git DATA directory (mission-control.db plus db
# backups), not a checkout. Any decoy that happens to hold a package.json
# therefore shadows the real checkout, and the update runs against the wrong
# directory. Two separate weaknesses, both fixed here:
#   (a) "has a package.json" proves nothing about repo identity, and
#   (b) first-match-wins silently picks between multiple real checkouts.
#
# A directory now qualifies ONLY when ALL of these hold:
#   * it is the TOP LEVEL of a git worktree — not merely a path inside one.
#     (`~/clawd/projects/blackceo-command-center` is a subdirectory of the
#     `~/clawd` repo, whose origin IS this repo; a bare "is it git + does
#     origin match" test would wrongly accept it.)
#   * that worktree's `origin` remote resolves to this repo, compared by
#     normalized repo slug so https / ssh / with- or without-.git all match.
#   * the app structure this updater actually drives is present: package.json
#     naming the app, next.config.mjs, ecosystem.config.cjs, src/, and
#     scripts/atomic-deploy.sh (Step 5 invokes that script from INSTALL_DIR).
# node_modules/ and .next/ are deliberately NOT required — Step 3 installs
# deps and Step 5 builds, so a pruned or freshly cloned checkout is valid.
#
# ZERO matches or MORE THAN ONE match is a hard failure. Guessing between two
# real checkouts is exactly how a box updates the copy nobody is serving.
CC_PKG_NAME="mission-control"
CC_REQUIRED_MARKERS=(
  "package.json"
  "next.config.mjs"
  "ecosystem.config.cjs"
  "src"
  "scripts/atomic-deploy.sh"
)

# Normalize a git remote URL to its bare repo name: handles
# https://host/owner/repo.git, git@host:owner/repo.git, and trailing slashes.
_cc_repo_slug() {
  local u="${1%/}"
  u="${u%.git}"
  u="${u##*/}"
  u="${u##*:}"
  printf '%s' "$u"
}

# Never echo a remote URL raw — an https remote can carry embedded
# credentials (https://user:token@host/...). Print the host onward only.
_cc_redact_url() {
  printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1***@#'
}

CC_EXPECTED_SLUG="$(_cc_repo_slug "$REPO_URL")"

# Validate one candidate. Sets CC_CANDIDATE_PATH (physical path) on success,
# CC_CANDIDATE_REASON (why it was rejected) on failure. Returns 0/1.
# These are globals on purpose: a command substitution would run the function
# in a subshell and the rejection reason would be lost.
CC_CANDIDATE_PATH=""
CC_CANDIDATE_REASON=""
_cc_validate_checkout() {
  local cand="$1"
  local phys top top_phys origin_url slug marker
  CC_CANDIDATE_PATH=""
  CC_CANDIDATE_REASON=""

  if [ ! -d "$cand" ]; then
    CC_CANDIDATE_REASON="no such directory"
    return 1
  fi
  phys=$(cd "$cand" 2>/dev/null && pwd -P) || phys=""
  if [ -z "$phys" ]; then
    CC_CANDIDATE_REASON="directory exists but is not readable"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    CC_CANDIDATE_REASON="git is not installed on this box — cannot verify any checkout"
    return 1
  fi
  top=$(git -C "$phys" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -z "$top" ]; then
    CC_CANDIDATE_REASON="not a git repository (plain directory or decoy)"
    return 1
  fi
  top_phys=$(cd "$top" 2>/dev/null && pwd -P) || top_phys="$top"
  if [ "$top_phys" != "$phys" ]; then
    CC_CANDIDATE_REASON="not a checkout root — it is a subdirectory of the git repo at $top_phys"
    return 1
  fi
  origin_url=$(git -C "$phys" config --get remote.origin.url 2>/dev/null) || origin_url=""
  if [ -z "$origin_url" ]; then
    CC_CANDIDATE_REASON="git repo has no 'origin' remote"
    return 1
  fi
  slug="$(_cc_repo_slug "$origin_url")"
  if [ "$slug" != "$CC_EXPECTED_SLUG" ]; then
    CC_CANDIDATE_REASON="origin remote is a different repo (got '$slug', expected '$CC_EXPECTED_SLUG')"
    return 1
  fi
  for marker in "${CC_REQUIRED_MARKERS[@]}"; do
    if [ ! -e "$phys/$marker" ]; then
      CC_CANDIDATE_REASON="Command Center repo, but the app structure is incomplete — missing $marker"
      return 1
    fi
  done
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"${CC_PKG_NAME}\"" "$phys/package.json" 2>/dev/null; then
    CC_CANDIDATE_REASON="package.json is not the Command Center app (expected \"name\": \"${CC_PKG_NAME}\")"
    return 1
  fi
  CC_CANDIDATE_PATH="$phys"
  return 0
}

INSTALL_DIR=""
INSTALL_DIR_SOURCE=""

# 1. Explicit pin. Validated, and a bad pin is FATAL: silently falling through
#    to autodetection would hide the operator's mistake behind a guess.
if [ -n "${CC_APP_DIR:-}" ]; then
  if _cc_validate_checkout "$CC_APP_DIR"; then
    INSTALL_DIR="$CC_CANDIDATE_PATH"
    INSTALL_DIR_SOURCE="CC_APP_DIR pin"
  else
    fatal "CC_APP_DIR is set to '$CC_APP_DIR' but that is not a Command Center checkout: ${CC_CANDIDATE_REASON}. Refusing to update an unvalidated directory. Fix the pin or unset CC_APP_DIR to autodetect."
  fi
fi

# 2. Autodetection. The canonical layout used fleet-wide by every other
# install/runtime script in this repo (scripts/atomic-deploy.sh's DB-resolve
# list, scripts/watchdog-cc.sh, scripts/seed-workspaces.py,
# scripts/install/mac-mini-bootstrap.sh, scripts/install/vps-docker-bootstrap.sh,
# and the onboarding repo's INSTALL.md clone target) is `~/projects/command-center`
# on Mac and `/data/projects/command-center` on VPS Docker boxes — list those
# FIRST. The older paths below never matched any documented install layout in
# this repo; they are kept only as a last-resort fallback for a box that was
# hand-installed off the documented path, so this autodetect can never regress
# a box that happened to depend on the old list. Order no longer decides the
# winner — every candidate is validated and exactly one must survive — but it
# is preserved so the "checked" list reads in the documented priority.
if [ -z "$INSTALL_DIR" ]; then
  CANDIDATES=(
    "$HOME/projects/command-center"
    "/data/projects/command-center"
    "$HOME/clawd/projects/blackceo-command-center"
    "/data/clawd/projects/blackceo-command-center"
    "$HOME/blackceo-command-center"
    "/data/blackceo-command-center"
  )
  CC_VALIDATED=()
  CC_REJECTED=()
  for c in "${CANDIDATES[@]}"; do
    if _cc_validate_checkout "$c"; then
      # Dedupe on the PHYSICAL path: two candidates that are symlinked
      # aliases of one checkout are one install, not an ambiguity.
      cc_dup=0
      if [ "${#CC_VALIDATED[@]}" -gt 0 ]; then
        for v in "${CC_VALIDATED[@]}"; do
          if [ "$v" = "$CC_CANDIDATE_PATH" ]; then cc_dup=1; break; fi
        done
      fi
      if [ "$cc_dup" -eq 0 ]; then
        CC_VALIDATED+=("$CC_CANDIDATE_PATH")
      fi
    elif [ -e "$c" ]; then
      # Only report paths that actually exist — a list of absent paths is noise.
      CC_REJECTED+=("$c — $CC_CANDIDATE_REASON")
    fi
  done

  if [ "${#CC_VALIDATED[@]}" -eq 0 ]; then
    echo "  Candidate paths checked, in order:"
    for c in "${CANDIDATES[@]}"; do echo "    - $c"; done
    if [ "${#CC_REJECTED[@]}" -gt 0 ]; then
      echo "  Paths that exist but were REJECTED:"
      for r in "${CC_REJECTED[@]}"; do echo "    - $r"; done
    else
      echo "  None of the candidate paths exist on this box."
    fi
    fatal "No validated Command Center checkout found. Nothing was changed. Re-run with the install pinned explicitly, e.g. CC_APP_DIR=/path/to/checkout CC_PM2_APP_NAME=<pm2 name> CC_PORT=<port> bash update.sh"
  fi

  if [ "${#CC_VALIDATED[@]}" -gt 1 ]; then
    echo "  Validated Command Center checkouts found:"
    for v in "${CC_VALIDATED[@]}"; do
      cc_head=$(git -C "$v" rev-parse --short HEAD 2>/dev/null || echo "unknown")
      cc_ver="unknown"
      if [ -f "$v/version" ]; then
        cc_ver=$(tr -d '[:space:]' < "$v/version" 2>/dev/null || echo "unknown")
      fi
      echo "    - $v  (HEAD $cc_head, version ${cc_ver:-unknown})"
    done
    fatal "Ambiguous install location: ${#CC_VALIDATED[@]} directories validate as Command Center checkouts. Refusing to guess which one this box serves — updating the wrong copy is silent and hard to undo. Nothing was changed. Re-run with the live one pinned: CC_APP_DIR=<path from the list above> CC_PM2_APP_NAME=<pm2 name> CC_PORT=<port> bash update.sh"
  fi

  INSTALL_DIR="${CC_VALIDATED[0]}"
  INSTALL_DIR_SOURCE="autodetect (exactly one candidate validated)"
fi

# Belt-and-braces: neither branch above may fall through empty. If one ever
# does, stop here rather than cd'ing to the current working directory.
if [ -z "$INSTALL_DIR" ]; then
  fatal "Command Center install location did not resolve. Cannot update."
fi
success "Found install at: $INSTALL_DIR"
echo "    source: $INSTALL_DIR_SOURCE"
echo "    origin: $(_cc_redact_url "$(git -C "$INSTALL_DIR" config --get remote.origin.url 2>/dev/null || echo unknown)")"
if [ -z "${CC_APP_DIR:-}" ]; then
  echo "    (autodetected — set CC_APP_DIR to pin this box explicitly)"
fi

cd "$INSTALL_DIR"

# ----------------------------------------------------------
# Backup retention + disk pre-check (OPENCLAW-BACKUP-RETENTION-V1)
# ----------------------------------------------------------
# Sourced from the checkout we are about to update — resolved AFTER
# INSTALL_DIR so this still works when update.sh itself was curl-piped and
# ${BASH_SOURCE[0]} is not a real path. If the library is genuinely absent
# (pre-retention checkout being updated for the first time) we do NOT fail the
# update — we fall back to defining no-ops so the old, unbounded-but-working
# behaviour is preserved for exactly one run; the update then installs the
# library and every run after this one prunes.
_CC_RETENTION_LIB=""
for _c in "$INSTALL_DIR/scripts/lib/backup-retention.sh" \
          "$(dirname "${BASH_SOURCE[0]}")/scripts/lib/backup-retention.sh"; do
  if [ -f "$_c" ]; then _CC_RETENTION_LIB="$_c"; break; fi
done
if [ -n "$_CC_RETENTION_LIB" ]; then
  # shellcheck source=scripts/lib/backup-retention.sh
  source "$_CC_RETENTION_LIB"
  success "Backup retention library: $_CC_RETENTION_LIB"
else
  warn "scripts/lib/backup-retention.sh not found in this checkout — backups will NOT be pruned this run (the update installs it; the next run prunes)."
  oc_backup_size_kb() { echo 0; }
  oc_backup_precheck_disk() { return 0; }
  oc_backup_prune() { return 0; }
fi

# ----------------------------------------------------------
# Backup
# ----------------------------------------------------------
step "Step 1: Backup"
if [ -d "/data/.openclaw" ]; then
  BACKUP_BASE="$HOME/blackceo-cc-backups"
else
  BACKUP_BASE="$HOME/Downloads/blackceo-cc-backups"
fi
BACKUP_DIR="$BACKUP_BASE/cc-backup-$(date +%Y%m%d-%H%M%S)"

# Pre-check disk BEFORE copying a byte. src/ + config/ is the bulk; measure it
# rather than guessing. A half-copied cc-backup-<ts> is worse than a refusal,
# and a loud early failure beats a confusing late one.
_CC_BACKUP_KB=0
for _p in src config version package.json package-lock.json CHANGELOG.md ecosystem.config.cjs; do
  [ -e "$_p" ] || continue
  _CC_BACKUP_KB=$(( _CC_BACKUP_KB + $(oc_backup_size_kb "$_p") ))
done
oc_backup_precheck_disk "$BACKUP_DIR" "$_CC_BACKUP_KB" "Command Center pre-update backup" \
  || fatal "Not enough free disk for the pre-update backup (details above). Nothing was changed."

mkdir -p "$BACKUP_DIR"

# Backup the critical files (not node_modules — too big)
for f in version package.json package-lock.json CHANGELOG.md ecosystem.config.cjs; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/" 2>/dev/null || true
done
if [ -d "src" ]; then
  cp -r src "$BACKUP_DIR/" 2>/dev/null || true
fi
if [ -d "config" ]; then
  cp -r config "$BACKUP_DIR/" 2>/dev/null || true
fi
success "Backup: $BACKUP_DIR"

# RETENTION: $BACKUP_BASE used to grow one cc-backup-<ts> tree per update
# forever. Prune to the newest N now that THIS run's backup is on disk — never
# before it, and never this run's own directory.
oc_backup_prune "$BACKUP_BASE" "cc-backup-" "$BACKUP_DIR"

# ----------------------------------------------------------
# Capture current version
# ----------------------------------------------------------
OLD_VERSION=""
[ -f version ] && OLD_VERSION=$(tr -d '[:space:]' < version)
success "Current version: ${OLD_VERSION:-unknown}"

# ----------------------------------------------------------
# Pull latest
# ----------------------------------------------------------
step "Step 2: Pull latest from GitHub"

# BRAND-01/02: per-box runtime config must SURVIVE the update and must not be
# Git state. The four mutable files are now ignored; tracked *.example.json
# files are fresh-install templates. This updater is also the migration for
# boxes created before that architecture landed.
#
# Before syncing, snapshot every customized runtime file byte-for-byte. A file
# is customized when it is untracked, differs from the worktree's HEAD (staged
# or unstaged), OR was changed by a local commit since the local/upstream merge
# base. That third case is critical: comparing only with HEAD cannot see a
# locally committed brand, and the old reset discarded that commit and its data.
#
# Sync with `git merge origin/main`, never `git reset --hard`. A merge retains
# local commits. The one expected migration conflict is "locally modified
# runtime file vs upstream deletion"; resolve only those four paths to the
# upstream deletion, then restore the snapshotted data as ignored runtime state.
# Any other merge conflict aborts the update without deploying. Uncommitted
# non-runtime work is stashed temporarily and APPLIED BACK before deployment.
PER_BOX_CONFIG_FILES=(
  "config/company-config.json"
  "config/departments.json"
  "config/board-slas.json"
  "public/logo-config.json"
)
PER_BOX_TEMPLATE_FILES=(
  "config/company-config.example.json"
  "config/departments.example.json"
  "config/board-slas.example.json"
  "public/logo-config.example.json"
)
PRESERVE_DIR="$BACKUP_DIR/per-box-config-preserve"
PRESERVED=()
if [ -d ".git" ]; then
  git fetch origin main 2>&1 || fatal "git fetch failed"
  OLD_HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  MERGE_BASE_SHA=$(git merge-base HEAD origin/main 2>/dev/null || true)

  for f in "${PER_BOX_CONFIG_FILES[@]}"; do
    customized=0
    if [ -f "$f" ]; then
      if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1 || \
         ! git diff --quiet HEAD -- "$f" 2>/dev/null || \
         { [ -n "$MERGE_BASE_SHA" ] && ! git diff --quiet "$MERGE_BASE_SHA" HEAD -- "$f" 2>/dev/null; }; then
        customized=1
        mkdir -p "$PRESERVE_DIR/$(dirname "$f")"
        cp "$f" "$PRESERVE_DIR/$f" 2>/dev/null \
          || fatal "Could not snapshot per-box config $f — refusing to sync (its per-box data would be lost)"
        cmp -s "$f" "$PRESERVE_DIR/$f" \
          || fatal "Snapshot verification of $f failed — refusing to sync (its per-box data would be lost)"
        PRESERVED+=("$f")
        success "Per-box config snapshotted (customized on this box): $f"
      fi

      # Remove runtime edits from Git's merge surface after the verified
      # snapshot. Tracked paths return to HEAD; untracked paths move out of the
      # way until restoration. This prevents a worktree edit from blocking the
      # architecture-migration merge.
      if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
        git checkout HEAD -- "$f" 2>/dev/null \
          || fatal "Could not prepare tracked runtime config $f for sync"
      elif [ "$customized" -eq 1 ]; then
        rm -f -- "$f"
      fi
    fi
  done

  STASH_SHA=""
  STASH_REF=""
  if [ -n "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
    warn "Local uncommitted work detected — stashing temporarily before update"
    git stash push --include-untracked -m "auto-stash before update-$(date +%s)" 2>&1 \
      || fatal "Could not stash local work — refusing to sync"
    STASH_SHA=$(git rev-parse --verify refs/stash 2>/dev/null || true)
    [ -n "$STASH_SHA" ] || fatal "Local-work stash could not be verified — refusing to sync"
    STASH_REF="stash@{0}"
  fi

  set +e
  git -c user.name="BlackCEO Command Center Updater" \
      -c user.email="updater@localhost" merge --no-edit origin/main 2>&1
  MERGE_RC=$?
  set -e
  if [ "$MERGE_RC" -ne 0 ]; then
    MERGE_CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)
    ONLY_RUNTIME_CONFLICTS=1
    [ -n "$MERGE_CONFLICTS" ] || ONLY_RUNTIME_CONFLICTS=0
    while IFS= read -r conflict; do
      [ -n "$conflict" ] || continue
      known=0
      for f in "${PER_BOX_CONFIG_FILES[@]}"; do
        [ "$conflict" = "$f" ] && known=1
      done
      [ "$known" -eq 1 ] || ONLY_RUNTIME_CONFLICTS=0
    done <<< "$MERGE_CONFLICTS"

    if [ "$ONLY_RUNTIME_CONFLICTS" -eq 1 ] && git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
      warn "Resolving expected one-time runtime-config migration conflicts"
      while IFS= read -r conflict; do
        [ -n "$conflict" ] && git rm -f -- "$conflict" >/dev/null
      done <<< "$MERGE_CONFLICTS"
      git -c user.name="BlackCEO Command Center Updater" \
          -c user.email="updater@localhost" commit --no-edit 2>&1 \
        || fatal "Could not record runtime-config migration merge"
    else
      git merge --abort >/dev/null 2>&1 || true
      if [ "${#PRESERVED[@]}" -gt 0 ]; then
        for f in "${PRESERVED[@]}"; do
          mkdir -p "$(dirname "$f")"
          cp "$PRESERVE_DIR/$f" "$f" 2>/dev/null || true
        done
      fi
      if [ -n "$STASH_SHA" ]; then
        git stash apply "$STASH_SHA" >/dev/null 2>&1 || true
      fi
      fatal "Upstream conflicts with locally committed code outside runtime config. Update aborted; local commits and stash were retained for manual merge."
    fi
  fi
  success "Merged latest origin/main without discarding local commits"

  # Restore customized files. For an uncustomized pre-migration box, generate
  # the ignored runtime file from the newly tracked template instead.
  for i in "${!PER_BOX_CONFIG_FILES[@]}"; do
    f="${PER_BOX_CONFIG_FILES[$i]}"
    template="${PER_BOX_TEMPLATE_FILES[$i]}"
    was_preserved=0
    if [ "${#PRESERVED[@]}" -gt 0 ]; then
      for kept in "${PRESERVED[@]}"; do
        [ "$kept" = "$f" ] && was_preserved=1
      done
    fi
    if [ "$was_preserved" -eq 1 ]; then
      mkdir -p "$(dirname "$f")"
      cp "$PRESERVE_DIR/$f" "$f" 2>/dev/null \
        || fatal "RESTORE of per-box config $f FAILED — do NOT deploy; snapshot preserved at $PRESERVE_DIR/$f"
      cmp -s "$PRESERVE_DIR/$f" "$f" \
        || fatal "Restore verification of $f FAILED (content mismatch) — do NOT deploy; snapshot preserved at $PRESERVE_DIR/$f"
      success "Per-box config restored (survives update): $f"
      if [ -n "$OLD_HEAD_SHA" ] && ! git diff --quiet "$OLD_HEAD_SHA" origin/main -- "$f" 2>/dev/null; then
        warn "Upstream changed the prior tracked default for $f — this box's per-box client data was kept in ignored runtime state."
      fi
    elif [ ! -f "$f" ] && [ -f "$template" ]; then
      mkdir -p "$(dirname "$f")"
      cp "$template" "$f" 2>/dev/null \
        || fatal "Could not generate runtime config $f from $template"
      cmp -s "$template" "$f" \
        || fatal "Generated runtime config $f failed verification"
      success "Per-box runtime config generated from template: $f"
    fi
  done

  # Put ALL non-runtime uncommitted work back. Apply first, drop only after a
  # clean apply; on conflict the recovery stash remains reachable and deploy is
  # refused rather than silently losing or shipping half-applied work.
  if [ -n "$STASH_SHA" ]; then
    if git stash apply "$STASH_SHA" 2>&1; then
      git stash drop "$STASH_REF" >/dev/null 2>&1 || true
      success "Local uncommitted work restored after update"
    else
      fatal "Updated code conflicts with stashed local work. Deploy refused; recovery stash retained at $STASH_SHA."
    fi
  fi

  # Verify the architecture invariant after migration: runtime config must not
  # be tracked. A future regression here would recreate the branding-wipe class.
  for f in "${PER_BOX_CONFIG_FILES[@]}"; do
    template=""
    for i in "${!PER_BOX_CONFIG_FILES[@]}"; do
      [ "${PER_BOX_CONFIG_FILES[$i]}" = "$f" ] && template="${PER_BOX_TEMPLATE_FILES[$i]}"
    done
    if [ -n "$template" ] && [ -f "$template" ] && git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      fatal "Runtime config $f is still git-tracked after update — refusing to deploy"
    fi
  done

  if [ "${#PRESERVED[@]}" -gt 0 ]; then
    for f in "${PRESERVED[@]}"; do
      success "Verified machine-local runtime config is outside Git: $f"
    done
  fi
else
  fatal "Install dir is not a git repo. Manual recovery required: clone $REPO_URL fresh."
fi

NEW_VERSION=""
[ -f version ] && NEW_VERSION=$(tr -d '[:space:]' < version)
success "New version: ${NEW_VERSION:-unknown}"

# ----------------------------------------------------------
# Install dependencies
# ----------------------------------------------------------
step "Step 3: Install npm dependencies"
if [ -f "package-lock.json" ]; then
  npm ci --no-audit --no-fund 2>&1 || npm install --no-audit --no-fund 2>&1 || fatal "npm install failed"
else
  npm install --no-audit --no-fund 2>&1 || fatal "npm install failed"
fi
success "Dependencies installed"

# ----------------------------------------------------------
# Run any database migrations (if seed files changed)
# ----------------------------------------------------------
step "Step 4: Database migrations (if applicable)"
# Schema/data migrations are applied automatically and idempotently by the
# TypeScript migration runner (src/lib/db/migrate.ts -> runMigrations) on start;
# there is nothing to apply here. The legacy seed-departments*.sql files are
# demo-only artifacts and now live (non-executed) under docs/archive/legacy-demo-sql/.
if [ -f "seed-departments-fixed.sql" ] || [ -f "seed-departments.sql" ]; then
  warn "Legacy demo seed SQL found at repo root — this is DEMO-ONLY data."
  warn "  Files: $(ls seed-departments*.sql 2>/dev/null | tr '\n' ' ')"
  warn "  Do NOT run these on a client/production box: they inject fake demo tasks."
  warn "  Real migrations run automatically via the app's migration runner."
  warn "  These files belong in docs/archive/legacy-demo-sql/ — move them there."
fi

# ----------------------------------------------------------
# Build + restart (atomic deploy)
# ----------------------------------------------------------
# BUILD-05: the old updater pulled new code + `npm ci`, then did a bare
# `pm2 reload` — it NEVER recompiled. pm2 reload restarts the process onto the
# SAME stale `.next` build, so freshly-merged pages/components never took effect
# (the dead client Kanban class). The recompile MUST happen between install and
# restart. We route through scripts/atomic-deploy.sh, which builds into a temp
# dir, gates on a FRESH .next/BUILD_ID (mtime > build start), atomically swaps
# .next (no missing-build window), restarts pm2 onto the fresh build, and
# health-checks with auto-rollback. We deliberately do NOT use a bare
# `npm run build` here (that path — used by the deprecated scripts/deploy.sh —
# does a non-atomic `rm -rf .next` before building, opening a window where the
# server has no build to serve).
step "Step 5: Build + restart (atomic deploy)"
# LIVE-DERIVED pm2 app name (was hardcoded to "blackceo-command-center").
# On a box whose live CC runs under a different pm2 name (e.g. an operator box
# running "cc-prod" on :4000), the hardcoded name matched NOTHING: the atomic
# deploy then restarted/started a SECOND app under the assumed name, which
# fought the live one for the port. Resolution order — LIVE state wins over
# any assumed name:
#   1. CC_PM2_APP_NAME env — the same override scripts/deploy.sh and
#      scripts/atomic-deploy.sh already honor.
#   2. The pm2 app actually declaring this box's CC port (pm2 jlist, parsed by
#      scripts/lib/pm2-port-zombies.py --resolve-name; online apps win).
#   3. Fleet-canonical "blackceo-command-center" (ecosystem.config.cjs) — only
#      for boxes with no CC under pm2 at all (fresh install).
CC_PM2_FALLBACK_NAME="blackceo-command-center"
# CC_PORT is an override on the same footing as CC_APP_DIR / CC_PM2_APP_NAME:
# when set it is used verbatim (for the pm2-port lookup below and passed
# through to atomic-deploy) instead of the built-in 4000 default. Echo it so
# the receipt shows which port this run actually targeted.
if [ -n "${CC_PORT:-}" ]; then
  success "CC port (CC_PORT override): $CC_PORT"
fi
PM2_NAME_LIB="$INSTALL_DIR/scripts/lib/pm2-port-zombies.py"
CC_PM2_NAME=""
if [ -n "${CC_PM2_APP_NAME:-}" ]; then
  CC_PM2_NAME="$CC_PM2_APP_NAME"
  success "pm2 app name (CC_PM2_APP_NAME override): $CC_PM2_NAME"
elif command -v pm2 >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && [ -f "$PM2_NAME_LIB" ]; then
  CC_PM2_NAME=$(pm2 jlist 2>/dev/null \
    | python3 -s "$PM2_NAME_LIB" --resolve-name "${CC_PORT:-4000}" "" 2>/dev/null \
    | head -1 || true)
  [ -n "$CC_PM2_NAME" ] && success "pm2 app name (live, declares port ${CC_PORT:-4000}): $CC_PM2_NAME"
fi
if [ -z "$CC_PM2_NAME" ]; then
  CC_PM2_NAME="$CC_PM2_FALLBACK_NAME"
  warn "No live pm2 app declares port ${CC_PORT:-4000} — using fleet-canonical name: $CC_PM2_NAME"
fi
ATOMIC_DEPLOY="$INSTALL_DIR/scripts/atomic-deploy.sh"

# atomic-deploy.sh requires bash 4+ (macOS system bash is 3.2). Resolve one.
BASH4=""
for _cand in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
  if command -v "$_cand" >/dev/null 2>&1 && \
     [ "$("$_cand" -c 'echo "${BASH_VERSINFO[0]:-0}"' 2>/dev/null || echo 0)" -ge 4 ]; then
    BASH4="$_cand"; break
  fi
done

DEPLOY_OK=0
if [ -f "$ATOMIC_DEPLOY" ] && [ -n "$BASH4" ]; then
  ADEPLOY_ARGS=(--app-dir "$INSTALL_DIR" --pm2-app "$CC_PM2_NAME")
  [ -n "${CC_PORT:-}" ] && ADEPLOY_ARGS+=(--port "$CC_PORT")
  # set -e is active for the updater; suspend it around the deploy so we can
  # inspect its exit-contract code (0 green / 1 rolled-back / 2 pre-flight / 3 unknown).
  set +e
  "$BASH4" "$ATOMIC_DEPLOY" "${ADEPLOY_ARGS[@]}"
  ADEPLOY_RC=$?
  set -e
  case "$ADEPLOY_RC" in
    0) success "Atomic deploy GREEN — fresh build compiled, atomically swapped, and serving"; DEPLOY_OK=1 ;;
    3) warn "Atomic deploy UNKNOWN (health indeterminate) — fresh build swapped but health not confirmed. NOT rolled back; investigate. See receipt above."; DEPLOY_OK=1 ;;
    1) fatal "Atomic deploy FAILED and auto-rolled-back to the prior build — the update did NOT take effect on the running server. See the atomic-deploy receipt above." ;;
    2) fatal "Atomic deploy pre-flight failed (disk / build / deps) — old build untouched, code NOT recompiled. Fix the reported issue and re-run this updater." ;;
    *) fatal "Atomic deploy exited with unexpected code $ADEPLOY_RC — refusing to declare the update successful." ;;
  esac
fi

if [ "$DEPLOY_OK" -ne 1 ]; then
  # DEGRADED FALLBACK: atomic-deploy.sh or bash 4+ is not available on this box
  # (older checkout / no Homebrew bash). We MUST still recompile — a plain
  # `pm2 reload` would serve the OLD build (the BUILD-05 bug). Do an IN-PLACE
  # `next build` (which writes into .next WITHOUT the destructive `rm -rf .next`
  # window scripts/deploy.sh used), verify a BUILD_ID landed, then reload pm2.
  warn "atomic-deploy.sh or bash 4+ not available — falling back to in-place build + reload (DEGRADED path)."
  set +e
  npm run build 2>&1 | tail -8
  BUILD_RC=${PIPESTATUS[0]}
  set -e
  [ "${BUILD_RC:-1}" -eq 0 ] || fatal "Build failed (exit ${BUILD_RC}) — refusing to reload onto a stale/broken build."
  [ -f "$INSTALL_DIR/.next/BUILD_ID" ] || fatal "Build produced no .next/BUILD_ID — refusing to reload onto an incomplete build."
  success "Rebuild complete (.next/BUILD_ID present)"

  if command -v pm2 >/dev/null 2>&1; then
    # Target the LIVE app name first — reloading ecosystem.config.cjs on a box
    # whose CC runs under a non-fleet name would START a second app that fights
    # the live one for the port (same defect class as the old hardcoded name).
    if pm2 list 2>/dev/null | grep -q "$CC_PM2_NAME"; then
      pm2 reload "$CC_PM2_NAME" 2>&1 || pm2 restart "$CC_PM2_NAME" 2>&1 || warn "PM2 reload failed — restart manually with: pm2 restart $CC_PM2_NAME"
      success "PM2 reloaded '$CC_PM2_NAME' onto fresh build"
    elif pm2 list 2>/dev/null | grep -q "command-center\|blackceo"; then
      pm2 reload ecosystem.config.cjs 2>&1 || pm2 restart all 2>&1 || warn "PM2 reload failed — restart manually with pm2 restart all"
      success "PM2 reloaded onto fresh build"
    else
      warn "PM2 installed but no command-center process found — start manually with: pm2 start ecosystem.config.cjs"
    fi
  else
    warn "PM2 not installed — restart the Next.js prod server manually."
  fi
fi

# ----------------------------------------------------------
# Operator kill-flag receipt (F6)
# ----------------------------------------------------------
# A deploy must never be the reason an operator's emergency stop quietly
# changed state. Report — after the swap — what the app will actually resolve
# on its next boot, and from where. This is a REPORT, never a mutation: the
# updater does not set, clear, or migrate a flag.
step "Step 6: Operator kill-flag receipt"
CC_OVERRIDES_FILE="${CC_OPERATOR_OVERRIDES_FILE:-}"
if [ -z "$CC_OVERRIDES_FILE" ]; then
  for _cand in "$HOME/.blackceo/command-center/operator-overrides.env" \
               "/data/.blackceo/command-center/operator-overrides.env"; do
    [ -f "$_cand" ] && { CC_OVERRIDES_FILE="$_cand"; break; }
  done
fi
KILLFLAG_DURABLE=""
[ -n "$CC_OVERRIDES_FILE" ] && [ -f "$CC_OVERRIDES_FILE" ] && \
  KILLFLAG_DURABLE=$(grep -E '^[[:space:]]*(export[[:space:]]+)?DISABLE_STALE_TASK_SWEEP[[:space:]]*=' "$CC_OVERRIDES_FILE" 2>/dev/null | tail -1 || true)
KILLFLAG_ENVFILE=""
for _envf in "$INSTALL_DIR/.env.production.local" "$INSTALL_DIR/.env.local"; do
  [ -f "$_envf" ] && KILLFLAG_ENVFILE=$(grep -E '^[[:space:]]*(export[[:space:]]+)?DISABLE_STALE_TASK_SWEEP[[:space:]]*=' "$_envf" 2>/dev/null | tail -1 || true)
  [ -n "$KILLFLAG_ENVFILE" ] && break
done

if [ -n "$KILLFLAG_DURABLE" ] || [ -n "$KILLFLAG_ENVFILE" ]; then
  warn "STALE-TASK SWEEP KILL-FLAG IS SET on this box — stale/blocked tasks are NOT being escalated."
  [ -n "$KILLFLAG_DURABLE" ] && warn "  durable override: $CC_OVERRIDES_FILE  ($KILLFLAG_DURABLE)"
  [ -n "$KILLFLAG_ENVFILE" ] && warn "  app env file (NOT deploy-proof — a re-clone or 'git clean -fdx' erases it): $KILLFLAG_ENVFILE"
  if [ -n "$KILLFLAG_ENVFILE" ] && [ -z "$KILLFLAG_DURABLE" ]; then
    warn "  This stop lives ONLY in the checkout. Make it survive the next deploy:"
    warn "    bash $INSTALL_DIR/scripts/operator-flag.sh set DISABLE_STALE_TASK_SWEEP 1"
  fi
  warn "  This is an emergency stop, not a resting state. Undo with:"
  warn "    bash $INSTALL_DIR/scripts/operator-flag.sh unset DISABLE_STALE_TASK_SWEEP"
else
  success "No operator kill-flag set — stale-task sweep will run (escalation active)."
fi

# ----------------------------------------------------------
# Write UPDATE PENDING flag for agent
# ----------------------------------------------------------
step "Step 7: Notify agent via AGENTS.md flag"
if [ -d "/data/clawd" ]; then
  WORKSPACE="/data/clawd"
else
  WORKSPACE="$HOME/clawd"
fi
AGENTS_FILE="$WORKSPACE/AGENTS.md"
mkdir -p "$WORKSPACE"
touch "$AGENTS_FILE"

# Remove old command-center flag SECTION if present.
# U53 (HL/U68) fix: this used to be a bare `grep -v` on the header line ONLY
# ("## 🔴 COMMAND CENTER UPDATE PENDING"), which stripped the header but left
# the numbered-steps body (the "was updated from X to Y" line through the
# "Backup of pre-update state:" line) orphaned in AGENTS.md on every repeat
# run — those stale bodies accumulate forever and mislead the box agent. This
# now removes the ENTIRE section (header through the trailing "Backup of
# pre-update state:" line) as one block. It also self-heals any header-less
# orphan bodies a previous run already left behind, by recognizing the same
# body's unique opening line even without its header still present.
awk '
  BEGIN { skip = 0 }
  /^##.*COMMAND CENTER UPDATE PENDING/ { skip = 1; next }
  skip == 0 && /^BlackCEO Command Center was updated from / { skip = 1; next }
  skip == 1 {
    if ($0 ~ /^Backup of pre-update state:/) { skip = 0 }
    next
  }
  { print }
' "$AGENTS_FILE" > "$AGENTS_FILE.tmp" 2>/dev/null || true
mv "$AGENTS_FILE.tmp" "$AGENTS_FILE" 2>/dev/null || true

cat >> "$AGENTS_FILE" <<EOF

## 🔴 COMMAND CENTER UPDATE PENDING

BlackCEO Command Center was updated from ${OLD_VERSION:-unknown} to ${NEW_VERSION:-unknown} on $(date -u +%Y-%m-%dT%H:%M:%SZ).

Read \`$INSTALL_DIR/CHANGELOG.md\` (top entry) and:
1. Verify the app is running (curl http://localhost:4000/api/health or check pm2 status)
2. Run any SQL migrations if the changelog mentions schema changes
3. Tell the owner: "Command Center updated to ${NEW_VERSION}. [list any items that need owner action]"
4. Remove this section from AGENTS.md when complete

Backup of pre-update state: $BACKUP_DIR
EOF
success "AGENTS.md flag written"

# ----------------------------------------------------------
# Record version + check timestamp
# ----------------------------------------------------------
date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.last-update-check" 2>/dev/null || true

step "Update complete"
echo ""
echo "  ✓ Command Center updated from ${OLD_VERSION:-unknown} to ${NEW_VERSION:-unknown}"
echo "  ✓ Backup: $BACKUP_DIR"
echo "  ✓ Log: $LOG_FILE"
echo "  ✓ Agent flag written to: $AGENTS_FILE"
echo ""
echo "  Next steps:"
echo "    1. Verify the app is responsive (curl /api/health if endpoint exists)"
echo "    2. Tell your agent: 'Process the COMMAND CENTER UPDATE PENDING section in my AGENTS.md'"
echo ""
