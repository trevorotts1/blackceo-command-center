'use client';

import { useEffect, useState } from 'react';
import { readApprovedCouncilPortraitRelease, type CouncilPortraitRelease } from './council-portrait-manifest';

/** Public asset lookup only; never starts a Council session or model request. */
export function useCouncilPortraitRelease() {
  const [release, setRelease] = useState<CouncilPortraitRelease | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readApprovedCouncilPortraitRelease(fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setRelease(result);
    });
    return () => controller.abort();
  }, []);
  return release;
}
