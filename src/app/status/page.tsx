'use client';

/**
 * /status (CTR-191 canonical "Service status" link target).
 *
 * The unchanged canonical How-it-works dialog links `/status`. The standalone
 * council service used to own that page; the Command Center must not point at
 * a second origin or invent a green health claim. This page reads the
 * Command Center's EXISTING protected status metadata endpoint
 * (`GET /api/system/status`, middleware-gated for this installation) and
 * prints exactly what it reports. A failed read, a missing dependency or an
 * offline/degraded component is shown as a typed blocked/degraded state; it is
 * never rendered as healthy.
 */

import { useEffect, useState } from 'react';

type ComponentStatus = {
  component: string;
  label?: string;
  status: string;
  tier?: string;
  error?: string | null;
  detail?: Record<string, unknown>;
};

type SystemStatusPayload = {
  overall: string;
  probedAt: string;
  components: ComponentStatus[];
  error?: string;
};

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: SystemStatusPayload }
  | { kind: 'blocked'; code: string; detail: string };

function isHealthy(overall: string): boolean {
  return overall === 'live';
}

export default function StatusPage() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/status', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (response) => {
        let body: SystemStatusPayload | null = null;
        try {
          body = (await response.json()) as SystemStatusPayload;
        } catch {
          body = null;
        }
        if (cancelled) return;
        if (!response.ok || !body) {
          setView({
            kind: 'blocked',
            code: 'STATUS_METADATA_UNAVAILABLE',
            detail: `The protected status metadata endpoint answered HTTP ${response.status} without a readable status payload.`,
          });
          return;
        }
        setView({ kind: 'ready', payload: body });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setView({
          kind: 'blocked',
          code: 'STATUS_METADATA_UNREACHABLE',
          detail: error instanceof Error ? error.message : 'The status endpoint did not answer.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ maxWidth: '46rem', margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ margin: '0 0 0.5rem' }}>
        <a href="/council">Back to the council</a>
      </p>
      <h1 style={{ margin: '0 0 0.5rem' }}>Service status</h1>
      <p style={{ margin: '0 0 1.5rem', color: '#555' }}>
        This page reports the Command Center&apos;s own protected status metadata. It does not
        query the standalone council service, and it never substitutes a healthy state when the
        metadata is unavailable.
      </p>

      {view.kind === 'loading' ? (
        <p role="status">Checking the protected status metadata...</p>
      ) : null}

      {view.kind === 'blocked' ? (
        <section role="alert" style={{ border: '1px solid #b00020', padding: '0.75rem 1rem' }}>
          <h2 style={{ margin: '0 0 0.35rem', fontSize: '1.05rem' }}>Blocked</h2>
          <p style={{ margin: '0 0 0.35rem' }}>
            <strong>{view.code}</strong>
          </p>
          <p style={{ margin: 0 }}>{view.detail}</p>
        </section>
      ) : null}

      {view.kind === 'ready' ? (
        <section aria-live="polite">
          <p style={{ margin: '0 0 0.75rem' }}>
            <strong>Overall: {view.payload.overall}</strong>
            {isHealthy(view.payload.overall) ? '' : ' — this is not a healthy state.'}
          </p>
          {view.payload.error ? (
            <p role="alert" style={{ border: '1px solid #b00020', padding: '0.75rem 1rem' }}>
              <strong>STATUS_METADATA_INCOMPLETE</strong> — {view.payload.error}
            </p>
          ) : null}
          <p style={{ margin: '0 0 0.75rem', color: '#555' }}>
            Probed at {view.payload.probedAt || 'an unrecorded time'}.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.35rem 0' }}>Component</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.35rem 0' }}>Status</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.35rem 0' }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {view.payload.components.map((component) => {
                const blocked = component.status === 'offline' || component.status === 'degraded';
                return (
                  <tr key={component.component}>
                    <td style={{ padding: '0.35rem 0', verticalAlign: 'top' }}>
                      {component.label || component.component}
                      {component.tier ? <span style={{ color: '#777' }}> ({component.tier})</span> : null}
                    </td>
                    <td style={{ padding: '0.35rem 0', verticalAlign: 'top' }}>
                      <strong>{component.status}</strong>
                      {blocked ? <span> — blocked</span> : null}
                    </td>
                    <td style={{ padding: '0.35rem 0', verticalAlign: 'top' }}>
                      {component.error ? component.error : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
    </main>
  );
}
