'use client';

/**
 * R-28 client-facing readiness surface. Renders the caller's own per-surface
 * readiness checklist — the same live `missing[]` the operator handshake
 * derives — fetched from /api/readiness/checklist on every view (no cache).
 */
import { useEffect, useState } from 'react';

interface Checklist {
  ready: boolean;
  companyId: string;
  missing: string[];
  error?: string;
}

const MISSING_LABELS: Record<string, string> = {
  dedicated_self_registration: 'Dedicated self registration',
  installation_id: 'Installation ID',
  company_record: 'Company record',
  persona_company_context_or_catalog: 'Persona company context or catalog',
  persona_catalog: 'Persona catalog',
  session_secret: 'Session secret',
  remote_receiver_secret: 'Remote receiver secret',
  interview_receiver_scripts: 'Interview receiver scripts',
};

export default function ReadinessPage() {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/readiness/checklist', {
      signal: controller.signal,
      headers: { 'cache-control': 'no-store' },
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Checklist | null;
          if (body && Array.isArray(body.missing)) {
            setChecklist(body);
            return;
          }
          throw new Error(`readiness checklist request failed (${res.status})`);
        }
        setChecklist((await res.json()) as Checklist);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Could not load readiness checklist.');
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui,sans-serif', maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Setup readiness</h1>
      {loadError ? (
        <p role="alert">{loadError}</p>
      ) : checklist === null ? (
        <p>Checking your setup…</p>
      ) : checklist.ready ? (
        <p>Your setup is ready.</p>
      ) : (
        <>
          <p>Still needed for your setup:</p>
          <ul>
            {checklist.missing.map((item) => (
              <li key={item}>{MISSING_LABELS[item] ?? item}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
