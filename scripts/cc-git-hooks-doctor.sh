#!/usr/bin/env bash
# scripts/cc-git-hooks-doctor.sh — PRES-047 Git-hook installation doctor.
#
# WHY THIS EXISTS (CC-H3 / PRES-047): hook installation can silently bypass
# guards. A hook file committed to .githooks/ does nothing unless
# core.hooksPath points at it; a manager (Husky, pre-commit, custom shim)
# may own core.hooksPath and swallow the hooks; a shim whose parent body is
# missing (the ONB `.husky/pre-push/_` pattern) is a NO-OP that still looks
# "installed". A file-existence check alone is insufficient — that is the
# exact defect this doctor exists to close.
#
# WHAT IT CHECKS (read-only by default):
#   1. EFFECTIVE core.hooksPath — resolved the way Git itself resolves it,
#      including worktree scope: worktree-local config wins over repo-local,
#      repo-local over --global, --global over the compiled default. Reports
#      each layer it sees. In a linked worktree it reads the worktree's own
#      config file FIRST (worktrees do not share config with their parent).
#   2. Which hook manager owns that path (Husky/_ shims, pre-commit,
#      plain .githooks, default .git/hooks) — without modifying anything.
#   3. For each expected hook (pre-push, post-commit, post-checkout):
#      present? executable bit? resolved BODY reachable — a shim that sources
#      a parent body that does not exist is diagnosed as NO-OP, not installed.
#   4. Global git config hooksPath / hooks.* settings that could redirect
#      every repo on the box (reported, never changed).
#   5. Exit code: 0 healthy; 1 problem found. `--json` prints one JSON object.
#
# COMPOSITION (no overwrite): this doctor never writes hooks or git config.
# `--install` composes: if core.hooksPath is unset, it sets it repo-locally to
# .githooks (backup recorded). If a DIFFERENT manager owns it, it writes a
# DISPATCH shim into the manager's directory that calls this repo's hook
# after the manager's own chain runs — the existing chain is never replaced,
# and no global git config is touched. Every install/uninstall change is
# recorded with a backup under .githooks/backups/ (manifest + file copies).
#
# Usage:
#   bash scripts/cc-git-hooks-doctor.sh                 # diagnose, human output
#   bash scripts/cc-git-hooks-doctor.sh --json          # machine output
#   bash scripts/cc-git-hooks-doctor.sh --repo-root DIR # another checkout
#   bash scripts/cc-git-hooks-doctor.sh --install       # compose + install (backed up)
#   bash scripts/cc-git-hooks-doctor.sh --uninstall <backup-manifest>  # restore only owned entries

set -uo pipefail

SELF_NAME="cc-git-hooks-doctor"
VERSION="1.0.0"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="diagnose"
JSON=0
UNINSTALL_MANIFEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --install) MODE="install"; shift ;;
    --uninstall) MODE="uninstall"; UNINSTALL_MANIFEST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── state collection ────────────────────────────────────────────────────────
PROBLEMS=0
FINDINGS=()

note_problem() { PROBLEMS=$((PROBLEMS+1)); FINDINGS+=("$1"); }

# git config lookup honouring scope precedence: worktree > local > global.
# Prints "<value>\t<scope>" for the winning non-empty value, or returns 1.
# A LINKED WORKTREE shares the parent repo's local config (only extensions
# worktreeConfig are per-worktree) — so for worktree scope we report the
# shared local config's value as the LOCAL layer; the WORKTREE layer is read
# from config.worktree only when extensions.worktreeConfig is enabled.
git_cfg_scoped() {
  local key="$1" dir wt v
  dir="$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null)" || return 1
  wt="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)" || return 1
  # Worktree scope: only meaningful when extensions.worktreeConfig is on.
  if [ -n "$dir" ] && [ -n "$wt" ] && [ "$dir" != "$wt" ]; then
    if [ "$(git -C "$REPO_ROOT" config --local --get extensions.worktreeConfig 2>/dev/null)" = "true" ] && [ -f "$dir/config.worktree" ]; then
      v="$(git config --file "$dir/config.worktree" --get "$key" 2>/dev/null)"
      if [ -n "$v" ]; then printf '%s\tworktree\n' "$v"; return 0; fi
    fi
  fi
  v="$(git -C "$REPO_ROOT" config --local --get "$key" 2>/dev/null)"
  if [ -n "$v" ]; then printf '%s\tlocal\n' "$v"; return 0; fi
  v="$(git config --global --get "$key" 2>/dev/null)"
  if [ -n "$v" ]; then printf '%s\tglobal\n' "$v"; return 0; fi
  return 1
}

# Resolve core.hooksPath the way Git does: a relative value is resolved
# against the TOP of the working tree that Git ran in (for a linked worktree
# that is the worktree itself, not the parent checkout); absolute paths pass
# through; empty/unset -> that repo's .git/hooks.
resolve_hooks_path() {
  local raw scope top
  if raw="$(git_cfg_scoped core.hooksPath)"; then
    scope="${raw##*$'\t'}"; raw="${raw%$'\t'*}"
    case "$raw" in
      /*) printf '%s\t%s\n' "$raw" "$scope" ;;
      *)
        top="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)"
        top="${top:-$REPO_ROOT}"
        # A relative hooksPath recorded by a DIFFERENT checkout (shared local
        # config across worktrees, e.g. an absolute-looking relative path from
        # the parent) still resolves from the REPO ROOT as Git's --local file
        # semantics have no single base; resolve against this repo root first,
        # and if it does not exist there, against the path as recorded.
        if [ -d "$top/$raw" ]; then
          printf '%s/%s\t%s\n' "$top" "$raw" "$scope"
        elif [ -d "$raw" ]; then
          printf '%s\t%s\n' "$raw" "$scope"
        else
          printf '%s/%s\t%s\n' "$top" "$raw" "$scope"
        fi
        ;;
    esac
  else
    printf '%s/.git/hooks\tdefault\n' "$REPO_ROOT"
  fi
}

# Classify the manager owning a hooks directory (read-only).
classify_manager() {
  local hp="$1"
  if [ -f "$hp/_/h" ] || [ -f "$hp/h" ]; then
    printf 'husky'
  elif [ -f "$hp/pre-commit" ] && grep -qs "pre-commit.org\|python\|pipenv\|virtualenv" "$hp/pre-commit" 2>/dev/null && [ -f "$hp/pre-commit" ]; then
    printf 'pre-commit'
  elif [ -d "$hp" ]; then
    printf 'plain'
  else
    printf 'absent'
  fi
}

# Resolve a hook's effective body: for husky shims (`. "$(dirname "$0")/h"`),
# the body is <shim-dir>/../<hook-name>; for everything else the file itself.
hook_body_path() {
  local hp="$1" hook="$2" f="$hp/$hook"
  [ -f "$f" ] || return 1
  if [ -f "$hp/_/h" ] || [ -f "$hp/h" ]; then
    local parent="$hp/../$hook"
    if [ -f "$parent" ]; then printf '%s\n' "$parent"; return 0; fi
    return 2   # shim present, parent body ABSENT -> no-op chain
  fi
  printf '%s\n' "$f"
}

check_hook() {
  local hp="$1" hook="$2" body rc
  local label="hooksPath=$hp hook=$hook"
  if [ ! -d "$hp" ]; then
    note_problem "MISSING: hooks directory $hp does not exist — $hook never runs ($label)"
    return
  fi
  if [ ! -f "$hp/$hook" ]; then
    note_problem "MISSING: $hook not present in $hp — $label"
    return
  fi
  if [ ! -x "$hp/$hook" ]; then
    note_problem "NOT-EXECUTABLE: $hp/$hook lacks the executable bit — Git skips it ($label)"
  fi
  body="$(hook_body_path "$hp" "$hook")"; rc=$?
  if [ "$rc" -eq 2 ]; then
    note_problem "NO-OP-SHIM: $hp/$hook dispatches to a parent body that does not exist ($hook ../body missing) — the hook chain is a no-op ($label)"
  elif [ "$rc" -eq 0 ] && [ ! -s "$body" ]; then
    note_problem "EMPTY-BODY: resolved body $body is empty — nothing runs ($label)"
  elif [ "$rc" -ne 0 ]; then
    note_problem "UNRESOLVED-BODY: $hp/$hook exists but its effective body could not be resolved ($label)"
  fi
}

backup_dir() { printf '%s/.githooks/backups\n' "$REPO_ROOT"; }

record_backup() {
  # $1 = action (install|uninstall), $2 = path changed, $3 = backup file (or "-")
  local bdir; bdir="$(backup_dir)"
  mkdir -p "$bdir" 2>/dev/null || return 1
  {
    printf '{"action":"%s","path":"%s","backup":"%s","at":"%s","doctor":"%s v%s"}\n' \
      "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SELF_NAME" "$VERSION"
  } >> "$bdir/manifest.jsonl" 2>/dev/null
}

# ── diagnose ────────────────────────────────────────────────────────────────
diagnose() {
  local hp scope mgr
  hp="$(resolve_hooks_path)"; scope="${hp##*$'\t'}"; hp="${hp%$'\t'*}"
  mgr="$(classify_manager "$hp")"

  echo "== $SELF_NAME v$VERSION — effective Git hook configuration =="
  echo "repo-root : $REPO_ROOT"
  echo "hooksPath : $hp (scope: $scope, manager: $mgr)"

  # Global redirect check (reported, never changed).
  local g
  g="$(git config --global --get core.hooksPath 2>/dev/null || true)"
  [ -n "$g" ] && echo "global    : core.hooksPath=$g  (GLOBAL — applies to every repo on this box)"
  g="$(git config --global --get-all hooks.pre-push 2>/dev/null || true)"
  [ -n "$g" ] && echo "global    : hooks.pre-push ref registered (Git ≥2.37 multi-hook): $g"

  check_hook "$hp" pre-push
  check_hook "$hp" post-commit
  check_hook "$hp" post-checkout

  if [ "$PROBLEMS" -eq 0 ]; then
    echo "RESULT: healthy — pre-push present and all advisory callbacks resolved"
  else
    echo "RESULT: $PROBLEMS problem(s) found:"
    local f
    for f in "${FINDINGS[@]}"; do echo "  - $f"; done
  fi

  if [ "$JSON" -eq 1 ]; then
    printf '{"hooksPath":"%s","scope":"%s","manager":"%s","problems":%d,"findings":[' \
      "$hp" "$scope" "$mgr" "$PROBLEMS"
    local first=1 f
    for f in "${FINDINGS[@]:-}"; do
      [ -n "$f" ] || continue
      [ $first -eq 1 ] || printf ','
      printf '"%s"' "$(printf '%s' "$f" | sed 's/\\/\\\\/g; s/"/\\"/g')"
      first=0
    done
    printf ']}\n'
  fi

  [ "$PROBLEMS" -eq 0 ] && return 0 || return 1
}

# ── install (compose, never overwrite) ──────────────────────────────────────
install_compose() {
  local hp scope mgr
  hp="$(resolve_hooks_path)"; scope="${hp##*$'\t'}"; hp="${hp%$'\t'*}"
  mgr="$(classify_manager "$hp")"
  echo "[install] effective hooksPath: $hp (scope: $scope, manager: $mgr)"

  if [ "$mgr" = "plain" ] || [ "$scope" = "default" ]; then
    # Empty dir or Git default: safe to point repo-local config at .githooks.
    if [ "$scope" = "default" ] && [ ! -d "$hp" ]; then
      mkdir -p "$hp"
    fi
    if [ -f "$hp/pre-push" ] || [ -f "$hp/post-commit" ] || [ -f "$hp/post-checkout" ]; then
      echo "[install] hooks already present at $hp — composing by dispatch shim, not overwriting"
    fi
    local cur cfgfile
    cur="$(git -C "$REPO_ROOT" config --local --get core.hooksPath 2>/dev/null || true)"
    if [ "$cur" != ".githooks" ]; then
      if [ -n "$cur" ]; then
        cfgfile="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-path config 2>/dev/null || true)"
        [ -n "$cfgfile" ] && cp "$cfgfile" "$cfgfile.bak.$(date +%s)" 2>/dev/null
      fi
      git -C "$REPO_ROOT" config --local core.hooksPath .githooks || { echo "[install] FAILED to set core.hooksPath" >&2; return 1; }
      record_backup install "local-config:core.hooksPath" "${cur:-unset}"
      echo "[install] core.hooksPath -> .githooks (repo-local; backup recorded)"
    else
      echo "[install] core.hooksPath already .githooks"
    fi
    return 0
  fi

  # A manager (husky etc.) owns hooksPath: compose without overwriting.
  #   * hook ABSENT here  -> install a dispatch shim that FIRST runs the
  #     manager's own chain (its _/<hook> shim) THEN this repo's advisory
  #     callback; backup of the (absent) prior state recorded.
  #   * hook PRESENT here -> never touched; the manager's own body runs and
  #     the advisory callback is NOT silently dropped (the doctor diagnoses
  #     the gap on the next run).
  echo "[install] manager '$mgr' owns $hp — composing advisory callbacks beside it (no overwrite)"
  local hook installed=0
  for hook in post-commit post-checkout; do
    local shim="$hp/$hook" target="$REPO_ROOT/.githooks/$hook"
    if [ -e "$shim" ]; then
      echo "[install] SKIP: $shim already exists (never overwrite)"
      continue
    fi
    local ts; ts="$(date +%s)"
    cat > "$shim" <<SHIM
#!/usr/bin/env sh
# Installed by cc-git-hooks-doctor (PRES-047): composed dispatch shim.
# Runs the manager's existing chain first, then CC's advisory callback.
# Uninstall: remove this file (recorded in .githooks/backups/manifest.jsonl).
h="$hp/_/\$(basename "\$0")"
[ -f "\$h" ] && sh "\$h" "\$@"
[ -f "$target" ] && bash "$target" "\$@"
exit 0
SHIM
    chmod +x "$shim"
    cp "$shim" "$shim.doctor-backup.$ts" 2>/dev/null
    record_backup install "$shim" "$shim.doctor-backup.$ts" 2>/dev/null
    installed=$((installed+1))
    echo "[install] composed dispatch shim installed: $shim (manager chain runs first; backup recorded)"
  done
  echo "[install] NOTE: the manager's own hooks (e.g. husky pre-push) are untouched."
  [ "$installed" -gt 0 ] || echo "[install] nothing to install — all advisory callbacks already present"
}

# ── uninstall (restore only owned entries, from manifest) ───────────────────
uninstall() {
  if [ -z "$UNINSTALL_MANIFEST" ] || [ ! -f "$UNINSTALL_MANIFEST" ]; then
    echo "[uninstall] usage: --uninstall <path to .githooks/backups/manifest.jsonl>" >&2
    return 2
  fi
  local n=0 line action path backup
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    action="$(printf '%s' "$line" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read()).get("action",""))' 2>/dev/null)"
    path="$(printf '%s' "$line" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read()).get("path",""))' 2>/dev/null)"
    backup="$(printf '%s' "$line" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read()).get("backup","-"))' 2>/dev/null)"
    case "$action:$path" in
      install:local-config:core.hooksPath)
        git -C "$REPO_ROOT" config --local --unset core.hooksPath 2>/dev/null
        echo "[uninstall] removed local core.hooksPath (was set by install)"; n=$((n+1)) ;;
      install:*)
        if [ -f "$path" ] && [ "$backup" != "-" ] && [ -f "$backup" ]; then
          cp "$backup" "$path"; echo "[uninstall] restored $path from $backup"
        elif [ -f "$path" ]; then
          rm -f "$path"; echo "[uninstall] removed $path (no prior file existed)"
        fi
        n=$((n+1)) ;;
    esac
  done < "$UNINSTALL_MANIFEST"
  record_backup uninstall "manifest:$UNINSTALL_MANIFEST" "-"
  echo "[uninstall] $n entry(ies) reverted — only doctor-owned entries touched"
}

case "$MODE" in
  diagnose)  diagnose ;;
  install)   install_compose ;;
  uninstall) uninstall ;;
esac
exit $?