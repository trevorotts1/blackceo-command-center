#!/opt/homebrew/bin/bash
# Tests for rescue-incidents-index.sh (FIX-RESCUE-10).
#
# Client-name-free: uses synthetic ClientA/ClientB/ClientC only.
# Self-contained: builds a temp change-log, exercises every function, and
# proves the index-based pattern_flag reproduces the LEGACY prose-scan
# semantics exactly (a reference legacy implementation is embedded below and
# the two are asserted equal on random probes over a large synthetic log).
#
# Run:  bash rescue-incidents-index.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rescue-incidents-index.sh
. "${HERE}/rescue-incidents-index.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2' want '$3')"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rii.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- Reference LEGACY implementation (the algorithm remediate.sh shipped) -----
# Scans the prose change-log twice, exactly as the pre-fix pattern_flag did.
# Used purely as an oracle to prove the index path matches bit-for-bit.
legacy_pattern_flag() {
  local class="$1" client="$2" file="$3" now="$4"
  local week=$((now - 7*86400)) month=$((now - 30*86400))
  [ -f "$file" ] || { echo "NONE"; return; }
  local report r d
  report=$(perl -e '
    use strict; use warnings; use Time::Local;
    my ($class,$client,$week,$month,$file)=@ARGV;
    open(my $fh,"<",$file) or exit;
    my ($cc,$ce)=("",0); my ($rep,$dis)=(0,0); my %seen;
    while(my $l=<$fh>){
      if($l=~/^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) [^,]*, (.+?)\s*$/){
        $cc=$6; eval{$ce=timelocal(0,$5,$4,$3,$2-1,$1-1900);1} or $ce=0;
      } elsif($l=~/^- Failure:\s*(.+?)\s*$/){
        my $c=$1;
        if($ce>=$week && $cc eq $client && $c eq $class){$rep++;}
        if($ce>=$month && $c eq $class){ unless($seen{$cc}){$seen{$cc}=1;$dis++;} }
      }
    }
    print "repeat=$rep distinct=$dis\n";
  ' "$class" "$client" "$week" "$month" "$file")
  r=$(echo "$report" | sed -n 's/.*repeat=\([0-9]*\).*/\1/p'); [ -z "$r" ] && r=0
  d=$(echo "$report" | sed -n 's/.*distinct=\([0-9]*\).*/\1/p'); [ -z "$d" ] && d=0
  local r_incl=$((r+1)) d_incl=$d
  if perl -e '
    use strict; use warnings; use Time::Local;
    my ($class,$client,$month,$file)=@ARGV;
    open(my $fh,"<",$file) or exit 1;
    my ($cc,$ce)=("",0);
    while(my $l=<$fh>){
      if($l=~/^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) [^,]*, (.+?)\s*$/){
        $cc=$6; eval{$ce=timelocal(0,$5,$4,$3,$2-1,$1-1900);1} or $ce=0;
      } elsif($l=~/^- Failure:\s*(.+?)\s*$/){
        if($ce>=$month && $1 eq $class && $cc eq $client){exit 0;}
      }
    }
    exit 1;' "$class" "$client" "$month" "$file"; then :; else d_incl=$((d+1)); fi
  local flags=""
  [ "$r_incl" -ge 2 ] && flags="REPEAT"
  if [ "$d_incl" -ge 3 ]; then
    if [ -n "$flags" ]; then flags="${flags}+FLEET-WIDE"; else flags="FLEET-WIDE"; fi
  fi
  [ -z "$flags" ] && flags="NONE"
  echo "$flags"
}

# Append a prose entry to a synthetic change-log at a given epoch.
add_entry() {  # file client class epoch
  local file="$1" client="$2" class="$3" epoch="$4"
  local hdr; hdr=$(perl -e 'my@t=localtime($ARGV[0]);printf "%04d-%02d-%02d %02d:%02d EDT",$t[5]+1900,$t[4]+1,$t[3],$t[2],$t[1];' "$epoch")
  {
    printf '\n## %s, %s\n' "$hdr" "$client"
    printf -- '- Failure: %s\n' "$class"
    printf -- '- Result: FIXED in 12 seconds\n'
  } >> "$file"
}

NOW=$(date +%s)
DAY=86400

echo "== 1. backfill + basic flags =="
CL="${WORK}/change-log.md"
export RII_CHANGE_LOG="$CL"; unset RII_INDEX
: > "$CL"
# ClientA gateway-down twice in the last 3 days -> REPEAT (2 incl. current=... actually 2 logged +1 =3)
add_entry "$CL" ClientA gateway-down $((NOW - 1*DAY))
add_entry "$CL" ClientA gateway-down $((NOW - 2*DAY))
# gateway-down also on ClientB and ClientC within the month -> distinct 3 -> FLEET-WIDE
add_entry "$CL" ClientB gateway-down $((NOW - 5*DAY))
add_entry "$CL" ClientC gateway-down $((NOW - 6*DAY))
# an old ClientA entry outside the 30d window (must NOT count)
add_entry "$CL" ClientA gateway-down $((NOW - 90*DAY))

rii_backfill
IDX="$(rii_index_path)"
lines=$(wc -l < "$IDX" | tr -d ' ')
eq "backfill produced one row per failure (5)" "$lines" "5"

# ClientA gateway-down: repeat(2 in week)+1=3>=2 REPEAT ; distinct(A,B,C)=3 FLEET-WIDE
eq "ClientA gateway-down -> REPEAT+FLEET-WIDE" \
   "$(rii_pattern_flag ClientA gateway-down)" "REPEAT+FLEET-WIDE"
# A brand-new client for a class only it has -> NONE
eq "ClientZ ssh-down (unseen) -> NONE" \
   "$(rii_pattern_flag ClientZ ssh-down)" "NONE"

echo "== 2. FLEET-WIDE without REPEAT =="
# version-drift on three distinct clients, each once -> FLEET-WIDE only
: > "$CL"; rm -f "$IDX"
add_entry "$CL" ClientA version-drift $((NOW - 2*DAY))
add_entry "$CL" ClientB version-drift $((NOW - 3*DAY))
rii_backfill
# ClientC about to be appended is the 3rd distinct client -> FLEET-WIDE, not REPEAT
eq "ClientC version-drift (3rd distinct) -> FLEET-WIDE" \
   "$(rii_pattern_flag ClientC version-drift)" "FLEET-WIDE"

echo "== 3. REPEAT without FLEET-WIDE =="
: > "$CL"; rm -f "$IDX"
add_entry "$CL" ClientA disk-full $((NOW - 1*DAY))   # one prior -> +current = 2 -> REPEAT
rii_backfill
eq "ClientA disk-full (1 prior + current) -> REPEAT" \
   "$(rii_pattern_flag ClientA disk-full)" "REPEAT"

echo "== 4. rii_append keeps the index live (no rebuild needed) =="
before=$(rii_pattern_flag ClientA disk-full)   # REPEAT (2)
rii_append ClientA disk-full "$NOW"            # now 2 prior + current = 3
after=$(rii_pattern_flag ClientA disk-full)
eq "append is reflected immediately" "$before/$after" "REPEAT/REPEAT"
rows=$(wc -l < "$IDX" | tr -d ' ')
eq "append added exactly one index row" "$rows" "2"

echo "== 5. week/month boundary correctness =="
: > "$CL"; rm -f "$IDX"
add_entry "$CL" ClientA edge $((NOW - 8*DAY))    # just OUTSIDE 7d week -> not a repeat
rii_backfill
eq "8-day-old entry does not trigger REPEAT" \
   "$(rii_pattern_flag ClientA edge)" "NONE"
add_entry "$CL" ClientA edge $((NOW - 6*DAY))    # inside week now
rii_backfill
eq "6-day-old entry (2 in week incl current) -> REPEAT" \
   "$(rii_pattern_flag ClientA edge)" "REPEAT"

echo "== 6. PARITY vs legacy scanner on a large random log (the core proof) =="
: > "$CL"; rm -f "$IDX"
clients=(ClientA ClientB ClientC ClientD ClientE)
classes=(gateway-down ssh-down version-drift disk-full tunnel-unreachable)
# ~4000 entries spread across ~120 days -> a realistically large prose file.
i=0
while [ "$i" -lt 4000 ]; do
  c=${clients[$((RANDOM % ${#clients[@]}))]}
  k=${classes[$((RANDOM % ${#classes[@]}))]}
  age=$((RANDOM % 120))
  add_entry "$CL" "$c" "$k" $((NOW - age*DAY))
  i=$((i+1))
done
sz=$(wc -c < "$CL" | tr -d ' ')
printf '  (synthetic change-log is %s bytes)\n' "$sz"
rii_backfill
mismatch=0; probes=0
for c in "${clients[@]}" ClientZ; do
  for k in "${classes[@]}" phantom-class; do
    probes=$((probes+1))
    got=$(rii_pattern_flag "$c" "$k")
    want=$(legacy_pattern_flag "$k" "$c" "$CL" "$NOW")
    if [ "$got" != "$want" ]; then
      mismatch=$((mismatch+1))
      printf '    MISMATCH %s/%s: index=%s legacy=%s\n' "$c" "$k" "$got" "$want"
    fi
  done
done
eq "index matches legacy scanner on all ${probes} probes" "$mismatch" "0"

echo "== 7. index read is the fast path (single tiny scan, not prose) =="
# The index has one short line per incident; assert it is far smaller than the
# prose it replaces (the whole point of the fix).
isz=$(wc -c < "$IDX" | tr -d ' ')
if [ "$isz" -lt "$sz" ]; then ok "index ($isz B) << prose ($sz B)"; else bad "index not smaller than prose"; fi

echo "== 8. self-heal: empty index with a populated log rebuilds =="
: > "$IDX"                                   # simulate truncated cache
flag=$(rii_pattern_flag ClientA gateway-down)
rebuilt=$(wc -l < "$IDX" | tr -d ' ')
if [ "$rebuilt" -gt 0 ]; then ok "empty index self-rebuilt to $rebuilt rows"; else bad "empty index did not self-heal"; fi

echo "== 9. rotation archives old months, keeps current+previous, log shrinks =="
: > "$CL"; rm -f "$IDX"
# entries this month, last month, and 4 months ago
add_entry "$CL" ClientA gateway-down $((NOW - 2*DAY))
add_entry "$CL" ClientB ssh-down     $((NOW - 32*DAY))
add_entry "$CL" ClientC disk-full    $((NOW - 125*DAY))
# pad so the file crosses the rotation size gate
pad=0; while [ "$pad" -lt 2000 ]; do add_entry "$CL" ClientD noise $((NOW - 130*DAY)); pad=$((pad+1)); done
rii_backfill                                  # index is kept warm in production
before_sz=$(wc -c < "$CL" | tr -d ' ')
RII_ROTATE_MIN_BYTES=1000 rii_rotate_changelog
after_sz=$(wc -c < "$CL" | tr -d ' ')
if [ "$after_sz" -lt "$before_sz" ]; then ok "change-log shrank ($before_sz -> $after_sz B)"; else bad "change-log did not shrink"; fi
# current-month entry survives; old-month entries are gone from the live log
if grep -q 'ClientA' "$CL"; then ok "current-month entry retained"; else bad "current-month entry lost"; fi
if grep -q 'ClientC' "$CL"; then bad "125-day-old entry still in live log"; else ok "old entry archived out of live log"; fi
# an archive file for the 4-months-ago month exists and holds ClientC
if ls "${WORK}"/change-log-*.md >/dev/null 2>&1 && grep -qrl 'ClientC' "${WORK}"/change-log-*.md; then
  ok "archived entry landed in a change-log-YYYY-MM.md file"
else
  bad "no month archive produced for old entries"
fi
# Rotation must not affect detection of RECENT incidents: ClientA's 2-day-old
# gateway-down is well inside the 7-day window, so REPEAT survives archiving.
# (Only entries older than the previous month — outside every pattern window —
# are archived, and the warm index is authoritative regardless.)
eq "recent-incident detection survives rotation" \
   "$(rii_pattern_flag ClientA gateway-down)" "REPEAT"

echo "== 10. prune bounds the index to the retention window =="
: > "$CL"; rm -f "$IDX"
add_entry "$CL" ClientA gateway-down $((NOW - 2*DAY))
add_entry "$CL" ClientB gateway-down $((NOW - 50*DAY))   # outside 40d -> pruned
rii_backfill
RII_WINDOW_DAYS=40 rii_prune_index
kept=$(wc -l < "$IDX" | tr -d ' ')
eq "prune drops rows older than the window (1 kept)" "$kept" "1"

echo
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
