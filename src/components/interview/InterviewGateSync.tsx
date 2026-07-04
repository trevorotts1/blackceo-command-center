'use client';

import { useEffect } from 'react';
import { refreshInterviewGate } from './gate-actions';

/**
 * Client shim that keeps the Edge-readable `mc_interview_complete` cookie warm
 * (P0-5). Mounted once from the root layout.
 *
 * The middleware (Edge) can't read fs/DB, so on every page load this asks the
 * Node `refreshInterviewGate` server action to derive completion from the
 * canonical build-state file and (re)sign the short-TTL cookie the middleware
 * reads. Rendering nothing; fire-and-forget — a failure is non-fatal because the
 * middleware fails closed to /interview when the cookie is absent.
 */
export default function InterviewGateSync() {
  useEffect(() => {
    refreshInterviewGate().catch(() => {
      /* non-fatal — middleware fails closed to /interview */
    });
  }, []);
  return null;
}
