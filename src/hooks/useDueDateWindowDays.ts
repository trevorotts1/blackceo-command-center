'use client';

import { useEffect, useState } from 'react';

/**
 * MR-44 (fix2) — resolve the board's effective "Tasks Due" filter window.
 *
 * The original MR-44 fix added the `dueDateWindowDays` prop to MissionQueue
 * and registered the knob in the board-SLA table (src/lib/board-slas.ts:
 * env `BOARD_DUE_DATE_WINDOW_DAYS` + per-department `config/board-slas.json`
 * override), but NOTHING ever read that config and passed it to the board —
 * both `<MissionQueue>` call sites relied on the hardcoded `= 7` prop
 * default, so the operator-facing knob was dead. This hook closes that gap.
 *
 * `resolveSlaThreshold` reads the filesystem (config/board-slas.json), which
 * a client component cannot do, so the resolution happens server-side in
 * GET /api/settings/board-slas and this hook just fetches the effective
 * value for the board's department. FAIL-CLOSED: any fetch/parse error (or a
 * non-positive value) leaves `fallback` in place — byte-identical to the
 * pre-fix hardcoded-7 behavior — so a missing route or a malformed config
 * can never corrupt the board's filter window.
 *
 * `department` is the board's department slug (null on the cross-department
 * /tasks/all board), matching the key board-slas.json is keyed by.
 */
export function useDueDateWindowDays(department: string | null | undefined, fallback = 7): number {
  const [days, setDays] = useState(fallback);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = department
          ? `/api/settings/board-slas?department=${encodeURIComponent(department)}`
          : '/api/settings/board-slas';
        const res = await fetch(url);
        if (!res.ok) return;
        const data = (await res.json()) as { dueDateWindowDays?: unknown };
        const v = data.dueDateWindowDays;
        if (!cancelled && typeof v === 'number' && Number.isFinite(v) && v > 0) {
          setDays(v);
        }
      } catch {
        // fail-closed: keep the fallback (the hardcoded default)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [department]);

  return days;
}
