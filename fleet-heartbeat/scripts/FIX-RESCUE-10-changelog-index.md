# FIX-RESCUE-10 — change-log O(n) hot-path fix: incidents.tsv index + rotation

**Priority:** P2 · **Area:** Rescue Rangers · **Wave:** 0

## Problem

`remediate.sh`'s `pattern_flag()` re-parsed the entire `change-log.md` prose file
with `perl` **twice on every fix** — once to count repeat/distinct occurrences,
once for the "already-counted distinct client" check. That file is ~1.05 MB and
grows **unbounded** (1,904 incident entries and counting), so the fix path pays an
O(n) prose parse that gets slower every day the fleet runs. `pattern_flag()` is
called on every remediation path in `remediate.sh` (~13 call sites), so the cost
lands on the latency-sensitive fix path.

## Fix

A derived, append-only **index** — `incidents.tsv` (one `\t`-separated row
`<epoch>\t<client>\t<class>` per incident) — that `pattern_flag()` reads instead
of re-parsing prose, plus a conservative **monthly rotation** of `change-log.md`
so the human audit file is also bounded. `change-log.md` stays the source of
truth for humans; the index is a cache that is rebuilt from it at any time and is
kept warm incrementally.

All logic ships in the client-name-free sourced library
`scripts/lib/rescue-incidents-index.sh`. Semantics are **identical** to the
legacy scanner (proven — see Verification).

### Library API (`rescue-incidents-index.sh`)

| function | purpose |
|---|---|
| `rii_pattern_flag CLIENT CLASS` | hot-path replacement: prints `NONE\|REPEAT\|FLEET-WIDE\|REPEAT+FLEET-WIDE` from the index only |
| `rii_append CLIENT CLASS [EPOCH]` | append one incident row (called right after the prose entry is written) |
| `rii_ensure` | backfill the index from `change-log.md` if missing/empty (one-time O(n), then incremental) |
| `rii_backfill` | force a full rebuild from prose (atomic, lock-guarded) |
| `rii_prune_index` | drop index rows older than `RII_WINDOW_DAYS` (default 40 > the 30-day window) |
| `rii_rotate_changelog` | archive `change-log.md` entries older than the previous month into `change-log-YYYY-MM.md` (size-gated, atomic) |
| `rii_maintain` | one fail-soft call for heartbeat startup: ensure + prune + rotate |
| `rii_index_path` | echo the resolved index path |

Paths are resolved from env (`RII_CHANGE_LOG` / `RII_INDEX`), defaulting to
`${CHANGE_LOG}` and a sibling `incidents.tsv` — no operator paths are baked in.

## Live wiring (applied to the deploy — `change-log.md`/`remediate.sh`/`heartbeat.sh` are runtime-only, not tracked in this public repo)

### `remediate.sh`

1. Source the library once, right after `CHANGE_LOG` is defined (line ~69):

   ```bash
   CHANGE_LOG="${ROOT}/change-log.md"
   RII_LIB="${ROOT}/scripts/lib/rescue-incidents-index.sh"
   [ -f "$RII_LIB" ] && . "$RII_LIB"
   ```

2. Make `pattern_flag()` delegate to the index, keeping the legacy prose scan as
   a fallback so behavior is unchanged if the library is ever absent (safe
   staged deploy):

   ```bash
   pattern_flag() {
     local class="$1"
     if command -v rii_pattern_flag >/dev/null 2>&1; then
       rii_pattern_flag "$CLIENT" "$class"
       return
     fi
     # ---- legacy fallback (unchanged prose double-scan) ----
     # ... existing perl body ...
   }
   ```

3. In `append_change_log()`, after the `} >> "$CHANGE_LOG"` block, keep the
   index in lock-step with the prose entry just written:

   ```bash
   } >> "$CHANGE_LOG"
   command -v rii_append >/dev/null 2>&1 && rii_append "$CLIENT" "$class" || true
   ```

   (`append_change_log` is already gated on `DRY_RUN` — the index is only ever
   written on real, logged incidents, exactly like the prose file.)

### `heartbeat.sh`

Warm/maintain the index once per fire, right after `CHANGE_LOG` is defined
(line ~34), fail-soft so a maintenance hiccup never blocks the heartbeat:

```bash
CHANGE_LOG="${ROOT}/change-log.md"
RII_LIB="${ROOT}/scripts/lib/rescue-incidents-index.sh"
if [ -f "$RII_LIB" ]; then
  . "$RII_LIB"
  rii_maintain 2>/dev/null || true   # ensure(one-time backfill) + prune + rotate
fi
```

On first run after deploy the index is missing, so `rii_ensure` backfills it from
the existing `change-log.md` once (28 ms on the current 1.05 MB file); every fix
thereafter appends a single row and reads only the compact index.

## Migration / rollback

- **Migration:** none required. First `rii_ensure`/`rii_pattern_flag` call
  self-backfills from the live `change-log.md`. No data is moved or deleted by
  the index; `change-log.md` is untouched until (optional) rotation runs.
- **Rollback:** delete `scripts/lib/rescue-incidents-index.sh` (the `command -v`
  guards make `pattern_flag`/`append_change_log` fall straight back to the legacy
  prose scan) and `rm incidents.tsv`. Rotation only ever *moves* old entries into
  `change-log-YYYY-MM.md` archives — no incident text is lost, and rotation is
  size-gated (default: only above 512 KiB) and disabled simply by not calling it.

## Verification (see `lib/rescue-incidents-index.test.sh`)

- 18/18 unit assertions green: REPEAT / FLEET-WIDE / combined / NONE, 7-day and
  30-day boundaries, incremental append, self-heal of a truncated index, prune,
  and rotation (archive old months, keep current+previous, recent detection
  survives).
- **Parity proof:** on a copy of the **real 1.05 MB `change-log.md`**, the
  index-based `rii_pattern_flag` matched the legacy double-scan on **all 545
  real (client, class) pairs — 0 mismatches**; and on a 4,000-entry synthetic
  log, 0 mismatches over 36 probes.
- **Performance:** backfill of the real 1.05 MB log = 28 ms (one-time); per-call
  `rii_pattern_flag` ≈ 6 ms vs ≈ 27 ms for the legacy double-scan (~4.5×), and
  the index scan is bounded to the 40-day window while the legacy cost grows
  unbounded with the prose file.
