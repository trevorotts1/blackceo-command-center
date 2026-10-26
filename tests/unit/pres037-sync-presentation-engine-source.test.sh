#!/usr/bin/env bash
# pres037-canonical-source.test.sh -- finding 37: sync must verify the
# SOURCE, not just that a checkout exists and the commit resolves.
#
# Before the fix, sync stamped the constant trevorotts1/openclaw-onboarding
# onto whatever checkout was handed to it, so any repo carrying the expected
# package tree became canonical. The checks below use throwaway local repos
# (no network): the tree is identical in every case, only the remote identity
# and the commit's mainline reachability change.
#
#   A. remote points elsewhere              -> REFUSED (exit 2), nothing copied
#   B. canonical https URL with credentials,
#      commit not on the mainline           -> REFUSED (exit 2), nothing copied
#   C. canonical scp URL, commit on mainline -> OK, manifest records the
#      verified source (repo/remote/url/mainline_ref)
#   D. non-git scheme (ext://) on a canonical-looking URL
#                                           -> REFUSED (exit 2), nothing copied
#   E. commit only on the checkout's local main,
#      no remote-tracking mainline          -> REFUSED (exit 2), nothing copied
#   F. foreign scheme hidden in scp userinfo
#      (javascript:alert(1)@github.com/...)  -> REFUSED (exit 2), nothing copied
#   G. normalize_remote_url table: 13 legitimate remote forms normalize to the
#      canonical repository, and the javascript: URL above lands on the ssh
#      host git itself routes it to ('javascript'), never on canonical
#   H. a refused remote URL carrying a credential -> the refusal text names
#      the normalized identity and never echoes the secret (CI logs)
#   I. a manifest that parses but is not shaped like one -> REFUSED (exit 2,
#      no traceback), in normal AND --warn mode
#   J. a tracked hand-added file with an otherwise matching manifest -> sync
#      must NOT claim "already at canonical": it removes the file, and the
#      parity gate then passes on the result
#
# Named after the tool under test (sync-presentation-engine) so pres039's
# T7 importer scan -- which excludes the parity tooling by name because it
# names the package to verify it -- keeps treating these fixture-path
# mentions as what they are, not as runtime importers.
#
# Usage: bash tests/unit/pres037-sync-presentation-engine-source.test.sh
# Exit 0 = all checks passed.
set -u
WT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOL="$WT/scripts/sync-presentation-engine.py"
PKG="23-ai-workforce-blueprint/templates/role-library/presentations/scripts/presentation_job"
CANON="trevorotts1/openclaw-onboarding"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pres037.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
g() { git -c user.email=qc@example.com -c user.name=QC -C "$1" "${@:2}"; }

# --- fixtures ----------------------------------------------------------------
mkdir -p "$TMP/src/$PKG"
printf 'ENGINE_DISTRIBUTOR = "canonical"\n' > "$TMP/src/$PKG/__init__.py"
printf '{"revision": 1}\n' > "$TMP/src/$PKG/data.json"
# The three files the built-in contract fallback reads, so a synced copy of
# this fixture can pass `verify` end to end (case J). Without them verify
# reports CONTRACT problems for reasons that have nothing to do with sync.
printf 'STATE_SCHEMA_VERSION = 1\n' > "$TMP/src/$PKG/state.py"
printf '# board: writes phase_id into activity metadata\n' > "$TMP/src/$PKG/board.py"
printf '%s\n' \
  'DISPATCH_CAPACITY_REFUSED = -4' \
  'DISPATCH_UNKNOWN_DECK_TYPE = -5' \
  'DISPATCH_CREDIT_REFUSED = -6' \
  'DISPATCH_NOTIFY_REFUSED = -7' \
  'CAPACITY_STATUS_UNDETERMINED = "undetermined"' \
  > "$TMP/src/$PKG/launcher.py"
g "$TMP/src" init -q
g "$TMP/src" add -A
g "$TMP/src" commit -qm "canonical tree"
C1="$(git -C "$TMP/src" rev-parse HEAD)"
printf '{"revision": 2}\n' > "$TMP/src/$PKG/data.json"
g "$TMP/src" add -A
g "$TMP/src" commit -qm "canonical tree, next commit"
C2="$(git -C "$TMP/src" rev-parse HEAD)"

mktgt() {  # fresh target repo so a refusal/copy in one case cannot leak into another
  local d="$TMP/tgt-$1"
  mkdir -p "$d"
  g "$d" init -q
  printf 'x\n' > "$d/README.md"
  g "$d" add -A
  g "$d" commit -qm init
  printf '%s' "$d"
}

# --- A: a checkout carrying the package tree, wrong remote -------------------
T_A="$(mktgt a)"
git -C "$TMP/src" remote remove origin >/dev/null 2>&1
git -C "$TMP/src" remote add origin "https://github.com/someone-else/openclaw-onboarding.git"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C1" --target "$T_A" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "no remote pointing at $CANON"; then
  ok "A: wrong remote refused (exit 2): $(printf '%s' "$OUT" | head -1)"
else
  bad "A: wrong remote NOT refused (rc=$RC): $OUT"
fi
if [ ! -e "$T_A/presentation_job" ]; then
  ok "A: refusal happened before any copy (no presentation_job/ written)"
else
  bad "A: presentation_job/ was written from a non-canonical checkout"
fi

# --- B: canonical URL but the commit is not on the mainline -----------------
T_B="$(mktgt b)"
git -C "$TMP/src" remote set-url origin \
  "https://x-access-token:not-a-real-token@github.com/$CANON.git"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C1"   # main is behind C2
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_B" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "is not on $CANON's mainline"; then
  ok "B: off-mainline commit refused (exit 2, credentials stripped for the compare)"
else
  bad "B: off-mainline commit NOT refused (rc=$RC): $OUT"
fi
if [ ! -e "$T_B/presentation_job" ]; then
  ok "B: refusal happened before any copy (no presentation_job/ written)"
else
  bad "B: presentation_job/ was written from an off-mainline commit"
fi

# --- C: canonical scp URL, commit on the mainline ---------------------------
T_C="$(mktgt c)"
git -C "$TMP/src" remote set-url origin "git@github.com:$CANON.git"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_C" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "C: canonical source accepted (exit 0)"
else
  bad "C: canonical source refused (rc=$RC): $OUT"
fi
if python3 - "$T_C/presentation_job/PARITY-MANIFEST.json" "$C2" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
src = m.get("source") or {}
assert m["canonical_repo"] == "trevorotts1/openclaw-onboarding", m.get("canonical_repo")
assert m["canonical_commit"] == sys.argv[2], m.get("canonical_commit")
assert src.get("repo") == "trevorotts1/openclaw-onboarding", src
assert src.get("remote") == "origin", src
assert src.get("url") == "https://github.com/trevorotts1/openclaw-onboarding", src
assert src.get("mainline_ref") == "refs/remotes/origin/main", src
EOF
then
  ok "C: manifest records the verified source (repo, remote, url, mainline_ref)"
else
  bad "C: manifest does not record the verified source"
fi
if [ -f "$T_C/presentation_job/data.json" ] \
   && grep -q '"revision": 2' "$T_C/presentation_job/data.json"; then
  ok "C: copied the pinned commit's bytes"
else
  bad "C: did not copy the pinned commit's bytes"
fi
g "$T_C" add -A >/dev/null 2>&1 && g "$T_C" commit -qm "synced" >/dev/null 2>&1
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_C" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "already at canonical"; then
  ok "C: second sync is a no-op (recorded source does not break idempotence)"
else
  bad "C: second sync was not a no-op (rc=$RC): $OUT"
fi

# --- D: a non-git scheme must not normalize to canonical ---------------------
T_D="$(mktgt d)"
git -C "$TMP/src" remote set-url origin "ext://github.com/$CANON"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_D" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "no remote pointing at $CANON"; then
  ok "D: non-git scheme refused (exit 2): $(printf '%s' "$OUT" | head -1)"
else
  bad "D: non-git scheme NOT refused (rc=$RC): $OUT"
fi
if [ ! -e "$T_D/presentation_job" ]; then
  ok "D: refusal happened before any copy (no presentation_job/ written)"
else
  bad "D: presentation_job/ was written from a non-canonical scheme"
fi

# --- E: local refs/heads/main is the checkout's state, never the mainline ----
T_E="$(mktgt e)"
git -C "$TMP/src" remote set-url origin "git@github.com:$CANON.git"
git -C "$TMP/src" update-ref -d refs/remotes/origin/main
g "$TMP/src" branch -f main "$C2" >/dev/null 2>&1
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_E" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "is not on $CANON's mainline"; then
  ok "E: commit only on local main refused (exit 2, local refs/heads/main excluded)"
else
  bad "E: local-main commit NOT refused (rc=$RC): $OUT"
fi
if [ ! -e "$T_E/presentation_job" ]; then
  ok "E: refusal happened before any copy (no presentation_job/ written)"
else
  bad "E: presentation_job/ was written from a commit with no remote mainline"
fi

# --- F: a foreign scheme hidden in scp userinfo must not read as canonical ---
# 'javascript:alert(1)@github.com/<canon>' is NOT userinfo + canonical host:
# git itself routes that URL to ssh host 'javascript' with path
# 'alert(1)@github.com/<canon>'. A normalizer whose userinfo group admits ':'
# swallows the whole prefix and false-PASSes the canonical repo.
T_F="$(mktgt f)"
git -C "$TMP/src" remote set-url origin "javascript:alert(1)@github.com/$CANON"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_F" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "no remote pointing at $CANON"; then
  ok "F: foreign scheme in scp userinfo refused (exit 2)"
else
  bad "F: foreign scheme in scp userinfo NOT refused (rc=$RC): $OUT"
fi
if [ ! -e "$T_F/presentation_job" ]; then
  ok "F: refusal happened before any copy (no presentation_job/ written)"
else
  bad "F: presentation_job/ was written from a javascript:-scheme remote"
fi

# --- G: normalize_remote_url -- 13 legitimate forms, one hostile form --------
if python3 - "$TOOL" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("spe", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
CANON = "github.com/trevorotts1/openclaw-onboarding"
accepted = [
    "git@github.com:trevorotts1/openclaw-onboarding.git",
    "git@github.com:trevorotts1/openclaw-onboarding",
    "https://github.com/trevorotts1/openclaw-onboarding",
    "https://github.com/trevorotts1/openclaw-onboarding.git",
    "https://x-access-token:tok@github.com/trevorotts1/openclaw-onboarding.git",
    "https://github.com:443/trevorotts1/openclaw-onboarding",
    "ssh://git@github.com:22/trevorotts1/openclaw-onboarding.git",
    "ssh://git@github.com/trevorotts1/openclaw-onboarding",
    "git://github.com/trevorotts1/openclaw-onboarding.git",
    "https://www.github.com/trevorotts1/openclaw-onboarding",
    "https://github.com/trevorotts1/openclaw-onboarding/",
    "https://github.com/trevorotts1/openclaw-onboarding?ref=main",
    "https://github.com/trevorotts1/openclaw-onboarding.git#main",
]
bad = []
for url in accepted:
    got = mod.normalize_remote_url(url)
    if got != CANON:
        bad.append("%s -> %s" % (url, got))
hostile = "javascript:alert(1)@github.com/trevorotts1/openclaw-onboarding"
got = mod.normalize_remote_url(hostile)
# Not merely "anything but canonical": git routes this URL to ssh host
# 'javascript' with path 'alert(1)@github.com/...', so that identity is what
# a correct normalizer must report. Pinning it catches a normalizer that
# empties the value or drops the host -- both != CANON, both useless.
if got != "javascript/alert(1)@github.com/trevorotts1/openclaw-onboarding":
    bad.append("%s -> %s (want ssh host 'javascript/...', never canonical)"
               % (hostile, got))
for line in bad:
    print("FAIL: normalize: " + line)
sys.exit(1 if bad else 0)
PYEOF
then
  ok "G: 13 legitimate forms normalize to canonical; javascript: form refused"
else
  bad "G: remote-URL normalization table failed"
fi

# --- H: a refusal must not echo the credential carried by the remote URL ----
# Refusal text lands in CI logs. Case B's credentialed remote is canonical and
# is never printed; a WRONG credentialed remote is the leak path.
T_H="$(mktgt h)"
SECRET="ghp_PRES037SECRET"
git -C "$TMP/src" remote set-url origin \
  "https://x-access-token:$SECRET@github.com/someone-else/openclaw-onboarding.git"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_H" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "someone-else/openclaw-onboarding"; then
  ok "H: wrong credentialed remote refused (exit 2) naming its normalized identity"
else
  bad "H: wrong credentialed remote NOT refused as expected (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "$SECRET"; then
  bad "H: refusal text echoed the credential into the log"
else
  ok "H: refusal text does not echo the credential"
fi

# --- I: a manifest that parses but is not shaped like one -------------------
# Structural breakage used to raise an uncaught TypeError (exit 1) -- reported
# as "verification failed" when the truth is "this is not a manifest".
BADM="$TMP/badmanifest"
mkdir -p "$BADM/presentation_job"
printf '{"files": "not-a-list"}\n' > "$BADM/presentation_job/PARITY-MANIFEST.json"
OUT="$(python3 "$TOOL" verify --target "$BADM" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "is not a manifest"; then
  ok "I: non-list files refused (exit 2)"
else
  bad "I: non-list files NOT refused cleanly (rc=$RC): $OUT"
fi
if printf '%s' "$OUT" | grep -q "Traceback"; then
  bad "I: structurally wrong manifest raised an uncaught traceback"
else
  ok "I: no traceback on a structurally wrong manifest"
fi
printf '{"files": ["x"]}\n' > "$BADM/presentation_job/PARITY-MANIFEST.json"
OUT="$(python3 "$TOOL" verify --target "$BADM" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "files\[0\]"; then
  ok "I: non-object record refused (exit 2)"
else
  bad "I: non-object record NOT refused (rc=$RC): $OUT"
fi
printf '{"files": [{"path": "data.json"}]}\n' > "$BADM/presentation_job/PARITY-MANIFEST.json"
OUT="$(python3 "$TOOL" verify --warn --target "$BADM" 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q "missing git_blob_sha"; then
  ok "I: record missing required keys refused (exit 2 even in --warn)"
else
  bad "I: record missing required keys NOT refused (rc=$RC): $OUT"
fi

# --- J: idempotence must not bless a tree the parity gate rejects ------------
# A tracked hand-added file leaves the manifest and every listed hash
# matching, so sync used to print "already at canonical" and exit 0 over it.
T_J="$(mktgt j)"
git -C "$TMP/src" remote set-url origin "git@github.com:$CANON.git"
git -C "$TMP/src" update-ref refs/remotes/origin/main "$C2"
python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_J" >/dev/null 2>&1
g "$T_J" add -A >/dev/null 2>&1 && g "$T_J" commit -qm "synced" >/dev/null 2>&1
printf 'SIDE_EFFECT = True\n' > "$T_J/presentation_job/stale_hand_edited.py"
g "$T_J" add -A >/dev/null 2>&1 && g "$T_J" commit -qm "hand-added" >/dev/null 2>&1
OUT="$(python3 "$TOOL" sync --source "$TMP/src" --commit "$C2" --target "$T_J" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q "already at canonical"; then
  bad "J: sync blessed a tree carrying an unlisted file: $OUT"
else
  ok "J: sync did not claim 'already at canonical' over an unlisted file"
fi
if [ "$RC" -eq 0 ] && [ ! -e "$T_J/presentation_job/stale_hand_edited.py" ]; then
  ok "J: sync removed the hand-added file (exit 0)"
else
  bad "J: hand-added file survived the sync (rc=$RC): $OUT"
fi
OUT="$(python3 "$TOOL" verify --target "$T_J" 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  ok "J: parity gate passes on the regenerated tree"
else
  bad "J: parity gate still fails after sync (rc=$RC): $OUT"
fi

echo "pres037: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
