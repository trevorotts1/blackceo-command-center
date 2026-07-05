# shellcheck shell=bash
# rescue-incidents-index.sh — FIX-RESCUE-10
#
# Problem this solves
# -------------------
# remediate.sh's pattern_flag() re-parsed the entire change-log.md prose file
# (~1.05 MB and growing unbounded) with perl TWICE on EVERY fix — once to count
# repeat/distinct occurrences and once for the "already-counted" check. That is
# O(n) latency creep on the hot fix path that gets worse every day the fleet
# runs. This library replaces the prose re-parse with a compact, append-only
# index (incidents.tsv) that pattern_flag reads instead, and provides a
# conservative monthly rotation for change-log.md so the human audit file is
# also bounded. change-log.md stays the source of truth for humans; the index
# is a derived cache that can be rebuilt from it at any time.
#
# This file is a SOURCED library (no shebang, no top-level side effects). It is
# intentionally client-name-free and path-free: callers pass paths via env.
#
# Contract (env, all optional — sensible defaults):
#   RII_CHANGE_LOG   path to change-log.md
#                    (default: ${CHANGE_LOG:-${ROOT:-.}/change-log.md})
#   RII_INDEX        path to the incidents index
#                    (default: alongside the change-log, named incidents.tsv)
#   RII_WINDOW_DAYS  index retention pruned during rotation (default 40;
#                    must stay > 30 so the FLEET-WIDE month window is intact)
#   RII_ROTATE_MIN_BYTES  only rotate change-log.md once it exceeds this
#                    (default 524288 = 512 KiB) — small logs are left alone
#
# Index row format (one physical line per logged incident, tab-separated):
#   <epoch>\t<client>\t<class>
#
# Pattern semantics are IDENTICAL to the legacy prose scanner:
#   REPEAT     = same client + same class in the last 7 days, >=2 occurrences
#                (counting the incident about to be appended)
#   FLEET-WIDE = same class on >=3 distinct clients in the last 30 days
#                (counting the client about to be appended)
#
# All mutating operations are atomic (temp + mv) and guarded by an mkdir lock so
# a rebuild can never race a rotate or a concurrent rebuild. Every function is
# fail-soft-friendly: callers may `|| true` any of them and lose nothing but the
# cache, which is transparently rebuilt on next use.

# Resolve RII_CHANGE_LOG / RII_INDEX from the environment, honoring anything the
# caller pre-set. Safe to call repeatedly.
_rii_paths() {
  if [ -z "${RII_CHANGE_LOG:-}" ]; then
    RII_CHANGE_LOG="${CHANGE_LOG:-${ROOT:-.}/change-log.md}"
  fi
  if [ -z "${RII_INDEX:-}" ]; then
    RII_INDEX="$(dirname "$RII_CHANGE_LOG")/incidents.tsv"
  fi
}

rii_index_path() { _rii_paths; printf '%s\n' "$RII_INDEX"; }

# Parse change-log.md prose into "<epoch>\t<client>\t<class>" rows on stdout.
# Mirrors remediate.sh's original regex + Time::Local(local-time) epoch exactly,
# so a rebuilt index reproduces the legacy scanner's results bit-for-bit.
_rii_parse_changelog() {
  local file="$1"
  perl -e '
    use strict; use warnings; use Time::Local;
    my ($file) = @ARGV;
    open(my $fh, "<", $file) or exit 0;
    my ($cur_cli, $cur_epoch) = ("", 0);
    while (my $line = <$fh>) {
      if ($line =~ /^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) [^,]*, (.+?)\s*$/) {
        my ($yy,$mm,$dd,$hh,$mi,$cli) = ($1,$2,$3,$4,$5,$6);
        $cur_cli = $cli;
        eval { $cur_epoch = timelocal(0, $mi, $hh, $dd, $mm-1, $yy-1900); 1 } or $cur_epoch = 0;
      } elsif ($line =~ /^- Failure:\s*(.+?)\s*$/) {
        my $cls = $1;
        # Tabs in a class name would corrupt the TSV; collapse defensively.
        $cls =~ s/\t/ /g;
        $cur_cli =~ s/\t/ /g;
        print "$cur_epoch\t$cur_cli\t$cls\n";
      }
    }
  ' "$file"
}

# Acquire the index lock (mkdir is atomic on POSIX). Returns non-zero if another
# process holds it. A stale lock older than 5 min is reclaimed.
_rii_lock() {
  _rii_paths
  local lock="${RII_INDEX}.lock"
  if mkdir "$lock" 2>/dev/null; then return 0; fi
  # Reclaim a stale lock (crashed rebuild) so we never wedge the fix path.
  if [ -d "$lock" ]; then
    local age now mtime
    now=$(date +%s)
    mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo "$now")
    age=$((now - mtime))
    if [ "$age" -gt 300 ]; then
      rmdir "$lock" 2>/dev/null || true
      mkdir "$lock" 2>/dev/null && return 0
    fi
  fi
  return 1
}
_rii_unlock() { _rii_paths; rmdir "${RII_INDEX}.lock" 2>/dev/null || true; }

# Rebuild the index from change-log.md (one O(n) prose scan, done at most once
# after deploy, then kept incremental by rii_append). Atomic. Lock-guarded so a
# concurrent caller that loses the lock simply proceeds on the existing index.
rii_backfill() {
  _rii_paths
  _rii_lock || return 0
  local tmp="${RII_INDEX}.tmp.$$"
  if [ -f "$RII_CHANGE_LOG" ]; then
    if ! _rii_parse_changelog "$RII_CHANGE_LOG" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; _rii_unlock; return 1
    fi
  else
    : > "$tmp"
  fi
  mv -f "$tmp" "$RII_INDEX"
  _rii_unlock
  return 0
}

# Ensure the index exists and is non-degenerate. Rebuilds when the index is
# missing, or is empty while the change-log clearly has incidents (truncation /
# corruption self-heal). Cheap on the common path (a single -s test).
rii_ensure() {
  _rii_paths
  if [ ! -f "$RII_INDEX" ]; then
    rii_backfill
    return $?
  fi
  if [ ! -s "$RII_INDEX" ] && [ -f "$RII_CHANGE_LOG" ] \
     && grep -q '^- Failure:' "$RII_CHANGE_LOG" 2>/dev/null; then
    rii_backfill
    return $?
  fi
  return 0
}

# Append one incident to the index. Called by append_change_log right after the
# prose entry is written. EPOCH defaults to now (the prose entry is timestamped
# now, so this stays consistent with the next pattern_flag's now-based window).
# The lone `>>` write is atomic for a single short line on local filesystems.
rii_append() {
  local client="$1" class="$2" epoch="${3:-$(date +%s)}"
  _rii_paths
  rii_ensure
  # Defensive: keep the TSV well-formed even if a caller passes embedded tabs.
  client=$(printf '%s' "$client" | tr '\t\n' '  ')
  class=$(printf '%s' "$class" | tr '\t\n' '  ')
  printf '%s\t%s\t%s\n' "$epoch" "$client" "$class" >> "$RII_INDEX"
}

# The hot-path replacement for pattern_flag's double prose scan. Reads ONLY the
# compact index and prints one of: NONE | REPEAT | FLEET-WIDE | REPEAT+FLEET-WIDE.
# Reproduces the legacy scanner's "+1 for the incident about to be appended"
# accounting for both the repeat count and the distinct-client set.
rii_pattern_flag() {
  local client="$1" class="$2"
  _rii_paths
  rii_ensure
  if [ ! -f "$RII_INDEX" ]; then echo "NONE"; return 0; fi
  local now week month
  now=$(date +%s)
  week=$((now - 7*86400))
  month=$((now - 30*86400))
  awk -F '\t' \
      -v cl="$client" -v cs="$class" -v week="$week" -v month="$month" '
    $3 == cs {
      if ($1 >= week && $2 == cl) repeat++
      if ($1 >= month) {
        if (!seen[$2]++) distinct++
        if ($2 == cl) selfmonth = 1
      }
    }
    END {
      r = repeat + 1                       # +1 for the incident being appended
      d = distinct + (selfmonth ? 0 : 1)   # +1 distinct client if not yet seen
      flags = ""
      if (r >= 2) flags = "REPEAT"
      if (d >= 3) flags = (flags == "" ? "FLEET-WIDE" : flags "+FLEET-WIDE")
      if (flags == "") flags = "NONE"
      print flags
    }' "$RII_INDEX"
}

# Prune the index to the last RII_WINDOW_DAYS (default 40 > the 30-day FLEET-WIDE
# window, so pattern detection is never weakened). Atomic + lock-guarded.
rii_prune_index() {
  _rii_paths
  [ -f "$RII_INDEX" ] || return 0
  local days="${RII_WINDOW_DAYS:-40}"
  case "$days" in ''|*[!0-9]*) days=40 ;; esac
  local cutoff; cutoff=$(( $(date +%s) - days*86400 ))
  _rii_lock || return 0
  local tmp="${RII_INDEX}.tmp.$$"
  awk -F '\t' -v cutoff="$cutoff" '$1 >= cutoff' "$RII_INDEX" > "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$RII_INDEX" || rm -f "$tmp"
  _rii_unlock
  return 0
}

# Conservative monthly rotation of change-log.md. Entries whose month is OLDER
# than the previous calendar month are moved into per-month archive files
# (change-log-YYYY-MM.md, appended) and removed from the live change-log, which
# is left holding only the current + previous month. Safe because pattern_flag
# now reads the index, never the prose — archiving cannot affect detection.
# No-op unless the change-log exceeds RII_ROTATE_MIN_BYTES. Atomic + locked.
rii_rotate_changelog() {
  _rii_paths
  [ -f "$RII_CHANGE_LOG" ] || return 0
  local minb="${RII_ROTATE_MIN_BYTES:-524288}"
  case "$minb" in ''|*[!0-9]*) minb=524288 ;; esac
  local size
  size=$(stat -f %z "$RII_CHANGE_LOG" 2>/dev/null || stat -c %s "$RII_CHANGE_LOG" 2>/dev/null || echo 0)
  [ "$size" -gt "$minb" ] || return 0

  _rii_lock || return 0
  local dir; dir=$(dirname "$RII_CHANGE_LOG")
  local keep="${RII_CHANGE_LOG}.keep.$$"
  # cutoff = first day of the PREVIOUS calendar month (YYYYMM as an integer).
  local cutoff_ym
  cutoff_ym=$(perl -e '
    my @t = localtime(time);
    my ($y,$m) = ($t[5]+1900, $t[4]+1);   # current year, month (1-12)
    $m--; if ($m < 1) { $m = 12; $y--; }  # step back to previous month
    printf "%04d%02d\n", $y, $m;
  ')

  # Split: keep entries with YYYYMM >= cutoff in the live log; append older
  # entries to per-month archive files. Entry = a "## header" line through the
  # line before the next "## " header (blank separators preserved).
  if ! perl -e '
    use strict; use warnings;
    my ($file, $keep, $dir, $cutoff) = @ARGV;
    open(my $in, "<", $file) or exit 1;
    open(my $kh, ">", $keep) or exit 1;
    my ($buf, $ym) = ("", 0);
    my %arch;   # ym => filehandle
    my $flush = sub {
      return if $buf eq "";
      if ($ym >= $cutoff || $ym == 0) {
        print $kh $buf;
      } else {
        unless ($arch{$ym}) {
          my $y = substr($ym,0,4); my $m = substr($ym,4,2);
          open(my $ah, ">>", "$dir/change-log-$y-$m.md") or die;
          $arch{$ym} = $ah;
        }
        print { $arch{$ym} } $buf;
      }
      $buf = ""; $ym = 0;
    };
    while (my $line = <$in>) {
      if ($line =~ /^## (\d{4})-(\d{2})-\d{2} /) {
        $flush->();
        $ym = $1 . $2;
      }
      $buf .= $line;
    }
    $flush->();
    close($kh);
    close($_) for values %arch;
    exit 0;
  ' "$RII_CHANGE_LOG" "$keep" "$dir" "$cutoff_ym"; then
    rm -f "$keep"; _rii_unlock; return 1
  fi

  # Only replace the live log if the split actually produced output (guards
  # against a perl error leaving an empty keep file).
  if [ -s "$keep" ] || [ ! -s "$RII_CHANGE_LOG" ]; then
    mv -f "$keep" "$RII_CHANGE_LOG"
  else
    rm -f "$keep"
  fi
  _rii_unlock
  return 0
}

# One call for heartbeat startup: warm/rebuild the index, prune it, and rotate
# the change-log — all fail-soft.
rii_maintain() {
  rii_ensure          || true
  rii_prune_index     || true
  rii_rotate_changelog || true
}
