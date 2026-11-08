#!/usr/bin/env bash
# ============================================================
#  BlackCEO Command Center — Check for Updates (READ-ONLY)
#  Compares local install against GitHub. NEVER updates anything.
#  Outputs structured JSON the cron agent reasons over.
# ============================================================

set -u
SCRIPT_VERSION="1.0.0"
REPO_NAME="blackceo-command-center"
REPO_URL="https://github.com/trevorotts1/${REPO_NAME}.git"
# Where this script lives: the registry beside it must be found no matter what
# directory the Sunday cron agent invokes the script from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_REGISTRY="$SCRIPT_DIR/config/update-target-registry.json"
# Approved target (pin). A fleet roll pins ONE main commit for every box, so
# the check must be measured against THAT commit. Comparing against a moving
# `main` reports updates the roll has not approved and hides the one it
# requires. The policy (required vs optional) comes from the registry below or
# the CC_REQUIRE_APPROVED_TARGET override; the reference defaults to main.
CC_UPDATE_TARGET="${CC_UPDATE_TARGET:-}"
CC_REQUIRE_APPROVED_TARGET="${CC_REQUIRE_APPROVED_TARGET:-}"
CC_UPDATE_BASE="${CC_UPDATE_BASE:-https://raw.githubusercontent.com/trevorotts1/${REPO_NAME}}"
CC_TARGET_REF="${CC_UPDATE_TARGET:-main}"
GH_RAW="${CC_UPDATE_BASE}/${CC_TARGET_REF}"

# ----------------------------------------------------------
# Detect install location
# ----------------------------------------------------------
# U53 (HL/U68) fix: this list was NEVER updated with the canonical
# `~/projects/command-center` (Mac) / `/data/projects/command-center` (VPS)
# layout that update.sh:42-50 already lists FIRST and that every other
# install/runtime script in this repo treats as "the canonical layout used
# fleet-wide" (scripts/atomic-deploy.sh, scripts/watchdog-cc.sh,
# scripts/seed-workspaces.py, scripts/install/mac-mini-bootstrap.sh,
# scripts/install/vps-docker-bootstrap.sh). Consequence before this fix: on
# every canonically-installed box, INSTALL_DIR resolved empty -> LOCAL_VERSION
# empty -> HAS_UPDATE computed true whenever the GitHub fetch succeeded ->
# permanent false "update available" on the Sunday cron. This also never
# honored a CC_APP_DIR override, unlike update.sh. Fixed by mirroring
# update.sh's resolution exactly: honor CC_APP_DIR first, then fall back to the
# canonical paths prepended ahead of the legacy last-resort candidates.
#
# TRAP-2: that mirror also inherited update.sh's bug — "directory contains a
# package.json" was the whole test, so a decoy could win. `~/projects/command-
# center` is FIRST in the list and on the operator Mac mini it exists as a
# non-git DATA directory. This file is READ-ONLY (it never updates anything),
# so it cannot abort the way update.sh does: the Sunday cron agent parses this
# JSON. Instead it validates identically and reports the outcome in two new
# fields, `install_dir_status` and `install_dir_detail`, so an unresolvable or
# ambiguous install is VISIBLE to the agent rather than silently reported
# against the wrong directory. Validation must stay identical to update.sh's
# _cc_validate_checkout — it is duplicated rather than sourced from a shared
# lib because the lib would live inside the very checkout being located.
CC_PKG_NAME="mission-control"
CC_REQUIRED_MARKERS=(
  "package.json"
  "next.config.mjs"
  "ecosystem.config.cjs"
  "src"
  "scripts/atomic-deploy.sh"
)
CC_EXPECTED_REPO_ID="github.com/trevorotts1/${REPO_NAME}"

CC_CANDIDATE_PATH=""
CC_CANDIDATE_REASON=""
# Normalize a git remote to "host/owner/repo" and compare THAT, everywhere.
# The old basename-only slug accepted any host and any owner: a checkout whose
# origin was <foreign-host>/<foreign-owner>/blackceo-command-center passed the
# guard, and the updater then fetched and deployed from it (finding 34).
# Handles https://[user[:token]@]host/owner/repo(.git),
# ssh://git@host[:port]/owner/repo.git, scp-style git@host:owner/repo.git, and
# explicit filesystem paths. The host tier is emitted only for network forms
# (a scheme other than file://, a userinfo@, or a host:path scp form) and is
# dropped for file:// and bare paths, so a filesystem path can never match a
# network remote — not even one spelled ./github.com/<owner>/<repo> or
# github.com/<owner>/<repo> on disk. Trailing slashes, ".git" and userinfo are
# dropped; the id is lowercased because hosts and GitHub paths are
# case-insensitive.
# Must stay byte-identical in update.sh, check-updates.sh and
# scripts/atomic-deploy.sh; scripts/l21-remote-db-guards.test.sh compares them.
_cc_repo_id() {
  local u="$1" host="" id="" n=0 net=0
  local -a parts=()
  u="${u%/}"; u="${u%.git}"; u="${u%/}"
  case "$u" in
    file://*) u="${u#*://}" ;;
    *://*)    u="${u#*://}"; net=1 ;;
  esac
  case "$u" in *@*) u="${u#*@}"; net=1 ;; esac
  case "${u%%:*}" in
    */*|"") ;;
    *) if [ "${u%%:*}" != "$u" ]; then u="${u%%:*}/${u#*:}"; net=1; fi ;;
  esac
  if [ -z "$u" ]; then return 0; fi
  IFS='/' read -r -a parts <<< "$u"
  n="${#parts[@]}"
  if [ "$n" -lt 2 ]; then return 0; fi
  case "${parts[0]}" in
    localhost|*.*) if [ "$net" -eq 1 ]; then host="${parts[0]%%:*}"; fi ;;
  esac
  if [ -n "$host" ]; then
    id="$host/${parts[n-2]}/${parts[n-1]}"
  else
    id="${parts[n-2]}/${parts[n-1]}"
  fi
  printf '%s' "$id" | tr '[:upper:]' '[:lower:]'
}
_cc_validate_checkout() {
  local cand="$1"
  local phys top top_phys origin_url repo_id marker
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
    CC_CANDIDATE_REASON="git is not installed on this box"
    return 1
  fi
  top=$(git -C "$phys" rev-parse --show-toplevel 2>/dev/null) || top=""
  if [ -z "$top" ]; then
    CC_CANDIDATE_REASON="not a git repository"
    return 1
  fi
  top_phys=$(cd "$top" 2>/dev/null && pwd -P) || top_phys="$top"
  if [ "$top_phys" != "$phys" ]; then
    CC_CANDIDATE_REASON="not a checkout root (subdirectory of the repo at $top_phys)"
    return 1
  fi
  origin_url=$(git -C "$phys" config --get remote.origin.url 2>/dev/null) || origin_url=""
  if [ -z "$origin_url" ]; then
    CC_CANDIDATE_REASON="no 'origin' remote"
    return 1
  fi
  repo_id="$(_cc_repo_id "$origin_url")"
  if [ "$repo_id" != "$CC_EXPECTED_REPO_ID" ]; then
    CC_CANDIDATE_REASON="origin is a different repo (got '${repo_id:-unparseable}', expected '$CC_EXPECTED_REPO_ID')"
    return 1
  fi
  for marker in "${CC_REQUIRED_MARKERS[@]}"; do
    if [ ! -e "$phys/$marker" ]; then
      CC_CANDIDATE_REASON="app structure incomplete — missing $marker"
      return 1
    fi
  done
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"${CC_PKG_NAME}\"" "$phys/package.json" 2>/dev/null; then
    CC_CANDIDATE_REASON="package.json is not the Command Center app"
    return 1
  fi
  CC_CANDIDATE_PATH="$phys"
  return 0
}

INSTALL_DIR=""
INSTALL_DIR_STATUS=""
INSTALL_DIR_DETAIL=""

if [ -n "${CC_APP_DIR:-}" ]; then
  if _cc_validate_checkout "$CC_APP_DIR"; then
    INSTALL_DIR="$CC_CANDIDATE_PATH"
    INSTALL_DIR_STATUS="pinned"
    INSTALL_DIR_DETAIL="pinned via CC_APP_DIR"
  else
    INSTALL_DIR_STATUS="pin_invalid"
    INSTALL_DIR_DETAIL="CC_APP_DIR is set but is not a Command Center checkout: ${CC_CANDIDATE_REASON}"
  fi
fi

if [ -z "$INSTALL_DIR" ] && [ "$INSTALL_DIR_STATUS" != "pin_invalid" ]; then
  # Registry-driven coverage: config/update-target-registry.json is the
  # shipped statement of which installed roots this repository actually
  # creates (the two canonical layouts) and which legacy layouts it still
  # tolerates. When the registry is readable it IS the candidate list, so a
  # new documented layout needs a registry edit rather than a script edit on
  # every box. The built-in list below is the standalone fallback (the U53
  # test extracts this block and runs it with no registry present).
  CANDIDATES=()
  CC_REG_CANDIDATES=""
  if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$CC_REGISTRY" ] && command -v python3 >/dev/null 2>&1; then
    CC_REG_CANDIDATES=$(python3 -I - "$CC_REGISTRY" <<'PYREG'
import json, os, sys
try:
    with open(sys.argv[1]) as fh:
        reg = json.load(fh)
except Exception:
    sys.exit(0)
home = os.path.expanduser("~")
for root in reg.get("install_roots") or []:
    p = root.get("path", "") if isinstance(root, dict) else str(root)
    if not p:
        continue
    print(p.replace("~", home, 1) if p.startswith("~") else p)
PYREG
    ) || CC_REG_CANDIDATES=""
  fi
  if [ -n "$CC_REG_CANDIDATES" ]; then
    while IFS= read -r c; do
      [ -n "$c" ] && CANDIDATES+=("$c")
    done <<< "$CC_REG_CANDIDATES"
  else
    CANDIDATES=(
      "$HOME/projects/command-center"
      "/data/projects/command-center"
      "$HOME/command-center/app"
      "$HOME/clawd/projects/blackceo-command-center"
      "/data/clawd/projects/blackceo-command-center"
      "$HOME/blackceo-command-center"
      "/data/blackceo-command-center"
    )
  fi
  CC_VALIDATED=()
  for c in "${CANDIDATES[@]}"; do
    if _cc_validate_checkout "$c"; then
      cc_dup=0
      if [ "${#CC_VALIDATED[@]}" -gt 0 ]; then
        for v in "${CC_VALIDATED[@]}"; do
          if [ "$v" = "$CC_CANDIDATE_PATH" ]; then cc_dup=1; break; fi
        done
      fi
      if [ "$cc_dup" -eq 0 ]; then
        CC_VALIDATED+=("$CC_CANDIDATE_PATH")
      fi
    fi
  done

  if [ "${#CC_VALIDATED[@]}" -eq 1 ]; then
    INSTALL_DIR="${CC_VALIDATED[0]}"
    INSTALL_DIR_STATUS="autodetected"
    INSTALL_DIR_DETAIL="exactly one validated checkout found"
  elif [ "${#CC_VALIDATED[@]}" -gt 1 ]; then
    INSTALL_DIR_STATUS="ambiguous"
    INSTALL_DIR_DETAIL="${#CC_VALIDATED[@]} validated checkouts found ($(printf '%s ' "${CC_VALIDATED[@]}" | sed 's/ $//')) — pin CC_APP_DIR; not reporting against a guess"
  else
    INSTALL_DIR_STATUS="not_found"
    INSTALL_DIR_DETAIL="no candidate path validated as a Command Center checkout — pin CC_APP_DIR"
  fi
fi

# Detect platform
if [ -d "/data/.openclaw" ]; then
  PLATFORM="vps"
else
  PLATFORM="mac"
fi

# ----------------------------------------------------------
# Read local version
# ----------------------------------------------------------
LOCAL_VERSION=""
if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/version" ]; then
  LOCAL_VERSION=$(tr -d '[:space:]' < "$INSTALL_DIR/version")
fi
LOCAL_PKG_VERSION=""
if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  LOCAL_PKG_VERSION=$(grep '"version"' "$INSTALL_DIR/package.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

# Installed COMMIT, not just the version string. The version file is a release
# stamp, and this repo's own gate requires the five stamp locations to AGREE,
# not to move on every commit (see .github/workflows/version-consistency.yml and
# the "[Unreleased]" CHANGELOG entries). A box can therefore sit hundreds of
# commits behind origin/main while /version still reads the same string. Without
# the commit, HAS_UPDATE below says "false" for exactly that box.
LOCAL_COMMIT=""
LOCAL_COMMIT_SHORT=""
if [ -n "$INSTALL_DIR" ]; then
  LOCAL_COMMIT=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)
  [ -n "$LOCAL_COMMIT" ] && LOCAL_COMMIT_SHORT="${LOCAL_COMMIT:0:12}"
fi

# ----------------------------------------------------------
# Approved-target policy
# ----------------------------------------------------------
# Required is opt-in: the registry's check-updates entry, or
# CC_REQUIRE_APPROVED_TARGET=1 on this box. Selectable because the fleet-wide
# decision is not made yet; when required, a missing pin REFUSES by name
# instead of silently measuring against moving main.
CC_TARGET_POLICY="optional"
if [ -n "$CC_REQUIRE_APPROVED_TARGET" ] && [ "$CC_REQUIRE_APPROVED_TARGET" != "0" ]; then
  CC_TARGET_POLICY="required"
elif [ -f "$CC_REGISTRY" ] && command -v python3 >/dev/null 2>&1; then
  CC_TARGET_POLICY=$(python3 -I - "$CC_REGISTRY" <<'PYREG'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        reg = json.load(fh)
except Exception:
    print("optional"); sys.exit(0)
for path in reg.get("update_paths") or []:
    if isinstance(path, dict) and path.get("name") == "check-updates" \
       and path.get("requires_approved_target") is True:
        print("required"); sys.exit(0)
print("optional")
PYREG
  ) || CC_TARGET_POLICY="optional"
fi
CC_TARGET_REFUSED="false"
if [ "$CC_TARGET_POLICY" = "required" ] && [ -z "$CC_UPDATE_TARGET" ]; then
  CC_TARGET_REFUSED="true"
fi

# ----------------------------------------------------------
# Fetch remote state
# ----------------------------------------------------------
fetch_remote() {
  curl -fsSL --max-time 15 "${GH_RAW}/$1" 2>/dev/null || echo ""
}

# Remote head: the commit LOCAL_COMMIT is compared against. Assigned EXACTLY
# ONCE here, on every path, so the JSON below can never reference an unbound
# variable. Sources, and none may touch the network when the check has already
# refused:
#   * refused  -> nothing at all; a refusal is a misconfiguration, not a
#                 reason to call GitHub.
#   * pinned   -> resolve CC_UPDATE_TARGET inside this checkout. A roll's
#                 commit IS the target; asking moving main would contradict
#                 the pin and spend a network round trip to learn nothing.
#   * unpinned -> a bounded, read-only `git ls-remote` of refs/heads/main.
#                 Empty on any network/auth failure, which leaves commit
#                 detection UNDETERMINED rather than guessing.
REMOTE_HEAD=""
REMOTE_HEAD_SOURCE=""
if [ "$CC_TARGET_REFUSED" != "true" ]; then
  if [ -n "$CC_UPDATE_TARGET" ]; then
    if [ -n "$INSTALL_DIR" ] && git -C "$INSTALL_DIR" cat-file -e "${CC_UPDATE_TARGET}^{commit}" 2>/dev/null; then
      _PIN_RESOLVED=$(git -C "$INSTALL_DIR" rev-parse "${CC_UPDATE_TARGET}^{commit}" 2>/dev/null || true)
      if [ -n "$_PIN_RESOLVED" ]; then
        REMOTE_HEAD="$_PIN_RESOLVED"
        REMOTE_HEAD_SOURCE="approved-target:${CC_UPDATE_TARGET}"
      fi
    fi
  elif command -v git >/dev/null 2>&1; then
    REMOTE_HEAD=$(
      GIT_TERMINAL_PROMPT=0 git \
        -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
        ls-remote --refs "$REPO_URL" refs/heads/main 2>/dev/null \
        | awk 'NR==1 { print $1 }'
    )
    [ -n "$REMOTE_HEAD" ] && REMOTE_HEAD_SOURCE="git ls-remote refs/heads/main"
  fi
fi

LATEST_VERSION=""
LATEST_CHANGELOG=""
if [ "$CC_TARGET_REFUSED" != "true" ]; then
  LATEST_VERSION=$(fetch_remote version | tr -d '[:space:]')
  LATEST_CHANGELOG=$(fetch_remote CHANGELOG.md)
fi

# Most recent changelog entry. Headings in this repo are written
# "## [vX.Y.Z] — date — title" (and "## [Unreleased]"), NOT "## vX.Y.Z"; the
# old `/^## v/` pattern matched NEITHER, so the excerpt was always empty and
# the agent was told nothing about what an update contained. Accept the
# bracketed and unbracketed forms and stop at the next heading of any level.
LATEST_ENTRY=""
if [ -n "$LATEST_CHANGELOG" ]; then
  LATEST_ENTRY=$(echo "$LATEST_CHANGELOG" | awk '
    /^## / {
      if (count == 0) {
        if ($0 ~ /^##[[:space:]]+\[?v[0-9]/ || $0 ~ /^##[[:space:]]+\[?[Uu]nreleased/) {
          count = 1; print; next
        }
        next
      }
      exit
    }
    count == 1 { print }
  ')
fi

# Which release the excerpt belongs to, so the reader never mistakes an
# [Unreleased] block for a shipped version.
EXCERPT_VERSION=""
if [ -n "$LATEST_ENTRY" ]; then
  EXCERPT_VERSION=$(printf '%s' "$LATEST_ENTRY" | head -1 | sed -E 's/^##[[:space:]]+\[?([^] ]+).*/\1/')
fi

# Risk hint
RISK_HINT=""
if [ -n "$LATEST_ENTRY" ]; then
  RISK_HINT=$(echo "$LATEST_ENTRY" | grep -iE "^### Risk:" | head -1 | sed -E 's/^### Risk:[[:space:]]*//I' | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
fi

# ----------------------------------------------------------
# Has update?
# ----------------------------------------------------------
# Two independent signals. The version string is a release stamp and does not
# move on every commit; the commit is what the box actually runs. A differing
# commit with an IDENTICAL version is the case this script used to miss
# (version_stamp_drift). If the remote/pinned commit cannot be read, the result
# falls back to the version comparison and update_reason says it is
# undetermined.
COMMIT_MATCHES_REMOTE=""
if [ -n "$LOCAL_COMMIT" ] && [ -n "$REMOTE_HEAD" ]; then
  if [ "$LOCAL_COMMIT" = "$REMOTE_HEAD" ]; then
    COMMIT_MATCHES_REMOTE="true"
  else
    COMMIT_MATCHES_REMOTE="false"
  fi
fi
COMMIT_MATCHES_REMOTE_JSON="null"
[ "$COMMIT_MATCHES_REMOTE" = "true" ] && COMMIT_MATCHES_REMOTE_JSON="true"
[ "$COMMIT_MATCHES_REMOTE" = "false" ] && COMMIT_MATCHES_REMOTE_JSON="false"

VERSION_STAMP_DRIFT="false"
if [ -n "$LATEST_VERSION" ] && [ "$LOCAL_VERSION" = "$LATEST_VERSION" ] \
   && [ "$COMMIT_MATCHES_REMOTE" = "false" ]; then
  VERSION_STAMP_DRIFT="true"
fi

HAS_UPDATE="false"
UPDATE_REASON=""
if [ -n "$LATEST_VERSION" ] && [ "$LOCAL_VERSION" != "$LATEST_VERSION" ]; then
  HAS_UPDATE="true"
  UPDATE_REASON="version"
fi
if [ "$COMMIT_MATCHES_REMOTE" = "false" ]; then
  HAS_UPDATE="true"
  if [ -n "$UPDATE_REASON" ]; then UPDATE_REASON="version+commit"; else UPDATE_REASON="commit"; fi
fi
if [ "$HAS_UPDATE" = "false" ]; then
  if [ -n "$LATEST_VERSION" ] && [ "$LOCAL_VERSION" = "$LATEST_VERSION" ] \
     && [ "$COMMIT_MATCHES_REMOTE" = "true" ]; then
    UPDATE_REASON="none"
  else
    UPDATE_REASON="undetermined"
  fi
fi

# Risk-tier classification fallback if no explicit tag
# (the agent will do better reasoning but this gives a baseline)
INFERRED_RISK="low"
if [ -n "$LATEST_ENTRY" ]; then
  if echo "$LATEST_ENTRY" | grep -qiE "breaking|migration|schema change|drop.*column|delete.*table|api version|deprecat"; then
    INFERRED_RISK="high"
  elif echo "$LATEST_ENTRY" | grep -qiE "added|new feature|new component|new dependency"; then
    INFERRED_RISK="medium"
  fi
fi

# ----------------------------------------------------------
# Compose JSON
# ----------------------------------------------------------
LATEST_ENTRY_JSON=$(printf '%s' "$LATEST_ENTRY" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)
[ -z "$LATEST_ENTRY_JSON" ] && LATEST_ENTRY_JSON='""'

# install_dir_detail is built from filesystem paths, so strip the two
# characters that could break out of a JSON string literal.
INSTALL_DIR_DETAIL_JSON=$(printf '%s' "$INSTALL_DIR_DETAIL" | tr -d '"\\')

CC_TARGET_PINNED="false"
[ -n "$CC_UPDATE_TARGET" ] && CC_TARGET_PINNED="true"
CC_STATUS="ok"
CC_REASON_CODE=""
if [ "$CC_TARGET_REFUSED" = "true" ]; then
  CC_STATUS="refused"
  CC_REASON_CODE="CC_UPDATE_TARGET_REQUIRED"
fi

cat <<JSON
{
  "script_version": "${SCRIPT_VERSION}",
  "repo": "${REPO_NAME}",
  "platform": "${PLATFORM}",
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "install_dir": "${INSTALL_DIR}",
  "install_dir_status": "${INSTALL_DIR_STATUS}",
  "install_dir_detail": "${INSTALL_DIR_DETAIL_JSON}",
  "local_commit": "${LOCAL_COMMIT}",
  "local_commit_short": "${LOCAL_COMMIT_SHORT}",
  "remote_head": "${REMOTE_HEAD}",
  "remote_head_source": "${REMOTE_HEAD_SOURCE}",
  "commit_matches_remote_head": ${COMMIT_MATCHES_REMOTE_JSON},
  "version_stamp_drift": ${VERSION_STAMP_DRIFT},
  "update_reason": "${UPDATE_REASON}",
  "target_ref": "${CC_TARGET_REF}",
  "target_pinned": ${CC_TARGET_PINNED},
  "target_policy": "${CC_TARGET_POLICY}",
  "status": "${CC_STATUS}",
  "reason_code": "${CC_REASON_CODE}",
  "local_version": "${LOCAL_VERSION}",
  "local_package_version": "${LOCAL_PKG_VERSION}",
  "latest_version": "${LATEST_VERSION}",
  "has_update": ${HAS_UPDATE},
  "risk_hint": "${RISK_HINT}",
  "inferred_risk": "${INFERRED_RISK}",
  "changelog_excerpt_version": "${EXCERPT_VERSION}",
  "changelog_excerpt": ${LATEST_ENTRY_JSON}
}
JSON

# A refused check is a misconfiguration, not "no update": signal it so the
# agent cannot read silence as a healthy box. Exit BEFORE the timestamp write
# so a refusal touches neither the network nor the checkout.
if [ "$CC_TARGET_REFUSED" = "true" ]; then
  exit 2
fi

# Record last check timestamp
if [ -n "$INSTALL_DIR" ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.last-update-check" 2>/dev/null || true
fi
exit 0
