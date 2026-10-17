'use client';

/**
 * useCouncilEntry (CWE-033, Skill 77; closes B10)
 *
 * The single presence/permission probe behind the ONE council entry
 * registration in src/lib/nav-gating.ts. It asks the council's own
 * capability endpoint (GET /api/council/capabilities, authorized
 * through CWE-007) whether the current principal may use the council,
 * and maps the outcome onto the fail-closed gate: the entry shows
 * only on a successful response. Loading, denial, and network failure
 * all keep the entry hidden. This hook decides menu visibility only;
 * authorization itself is enforced by the council API and routes on
 * every request (Directive Section 28).
 */

import { useEffect, useState } from 'react';
import {
  shouldShowCouncilNavItem,
  type CouncilCapabilityStatus,
} from '@/lib/nav-gating';

export interface CouncilEntryVisibility {
  status: CouncilCapabilityStatus;
  /** True only when the capabilities probe succeeded (fail-closed). */
  show: boolean;
}

export function useCouncilEntry(): CouncilEntryVisibility {
  const [status, setStatus] = useState<CouncilCapabilityStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/council/capabilities', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (cancelled) return;
        if (!response.ok) {
          setStatus('error');
          return;
        }
        const payload = (await response.json().catch(() => null)) as
          | { ok?: unknown }
          | null;
        if (cancelled) return;
        setStatus(payload && payload.ok === true ? 'ok' : 'error');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, show: shouldShowCouncilNavItem(status) };
}
