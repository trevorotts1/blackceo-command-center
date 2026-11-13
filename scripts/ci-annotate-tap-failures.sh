#!/usr/bin/env bash
# Print every failing test in a Node TAP log as a GitHub file annotation (::error file=...).
# Usage: ci-annotate-tap-failures.sh unit.tap
# The file comes from the test name when it is a tests/ path, else from the `location:` line TAP prints under
# the failure; with neither, the annotation points at tests/unit.
set -u
tap="${1:?usage: ci-annotate-tap-failures.sh <tap-file>}"
[ -r "$tap" ] || { echo "ci-annotate-tap-failures: cannot read $tap" >&2; exit 2; }
awk '
  function esc(s) { gsub(/%/, "%25", s); gsub(/\r/, "", s); return s }
  function flush() {
    if (pending != "") {
      f = file; if (f == "") f = "tests/unit"
      print "::error file=" f ",title=Unit test failed::" esc(pending)
      n++
    }
    pending = ""; file = ""
  }
  function path_in(s,   m) {
    if (match(s, /tests\/[A-Za-z0-9_.\/-]+\.test\.[a-z]+/)) return substr(s, RSTART, RLENGTH)
    return ""
  }
  /^[ \t]*not ok [0-9]+ - / {
    flush()
    line = $0; sub(/^[ \t]+/, "", line)
    pending = line; file = path_in(line)
    next
  }
  pending != "" && file == "" && /location:/ { file = path_in($0) }
  /^[ \t]*(ok|not ok) [0-9]+ - |^# (tests|pass|fail) / { if ($0 !~ /not ok/) flush() }
  END { flush(); if (n == 0) print "no failing tests found in the TAP log" }
' "$tap"
