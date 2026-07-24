'use client';

import { useEffect, useRef } from 'react';
import { refreshInterviewGate } from './gate-actions';

/**
 * Client shim that keeps the Edge-readable `mc_interview_complete` cookie warm
 * (P0-5 / U010). Mounted once from the root layout.
 *
 * The middleware (Edge) can't read fs/DB, so on every page load this asks the
 * Node `refreshInterviewGate` server action to derive completion from the
 * canonical build-state file and (re)sign the cookie the middleware reads.
 * U010: retries once after 2s on first failure, so a post-fallback admission
 * reliably re-sets the cookie the middleware fallback could not mint.
 * Rendering nothing; fire-and-forget — a persistent failure is non-fatal
 * because the middleware falls back to /api/interview/gate-status.
 */
export default function InterviewGateSync() {
  const retried = useRef(false);
  useEffect(() => {
    refreshInterviewGate().catch(() => {
      if (!retried.current) {
        retried.current = true;
        setTimeout(() => {
          refreshInterviewGate().catch(() => {
            /* persistent failure — non-fatal; middleware fallback still active */
          });
        }, 2000);
      }
    });
  }, []);
  return null;
}
