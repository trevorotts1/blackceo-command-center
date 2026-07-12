'use client';

/**
 * /sops/[id] — SOP detail view.
 *
 * P2-02 fix: the TaskModal "Who's Working On This" SOP panel
 * (src/components/TaskOverviewPanels.tsx) renders the attached SOP as a named
 * link `href="/sops/<id>"`. That link previously had NO page route behind it —
 * only `/sops/proposals` existed and there is no next.config rewrite — so
 * clicking the SOP name 404'd (a dead control, violating P2-02 step 6 / QC (e)
 * "zero dead controls"). This page is that link's real target: a read-only
 * detail view that resolves the SOP by id OR slug via GET /api/sops/[id] (the
 * route already accepts either) and renders its steps, success criteria, and
 * metadata — with an honest 404 empty-state when the id does not resolve.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface SopStep {
  name: string;
  checklist?: string[];
  success_criteria?: string;
}

interface Sop {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  version: number;
  department?: string | null;
  role?: string | null;
  source?: string | null;
  task_keywords?: string | null;
  steps: string; // JSON-serialized SopStep[]
  success_criteria?: string | null;
  persona_hints?: string | null; // JSON-serialized string[]
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

type LoadState = 'loading' | 'ok' | 'not-found' | 'error';

export default function SopDetailPage() {
  const routeParams = useParams<{ id: string }>();
  const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id;
  const [sop, setSop] = useState<Sop | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setState('loading');
    fetch(`/api/sops/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setState('not-found');
          return;
        }
        if (!res.ok) {
          setState('error');
          return;
        }
        const data = await res.json();
        // /api/sops/[id] returns the SOP row (or { sop }) — tolerate both shapes.
        const row: Sop | null = data?.sop ?? data ?? null;
        if (!row || !row.id) {
          setState('not-found');
          return;
        }
        setSop(row);
        setState('ok');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  let steps: SopStep[] = [];
  let hints: string[] = [];
  if (sop) {
    try {
      const parsed = JSON.parse(sop.steps);
      if (Array.isArray(parsed)) steps = parsed;
    } catch {
      steps = [];
    }
    if (sop.persona_hints) {
      try {
        const parsed = JSON.parse(sop.persona_hints);
        if (Array.isArray(parsed)) hints = parsed.filter((h) => typeof h === 'string');
      } catch {
        hints = [];
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4">
        <a href="/sops/proposals" className="text-xs text-zinc-500 hover:text-zinc-300">
          &larr; SOP library
        </a>
      </div>

      {state === 'loading' && (
        <div className="rounded border border-zinc-700 bg-zinc-900 p-6 text-sm text-zinc-400">
          Loading SOP&hellip;
        </div>
      )}

      {state === 'not-found' && (
        <div className="rounded border border-dashed border-zinc-700 p-8 text-center">
          <h1 className="text-lg font-medium text-zinc-200">SOP not found</h1>
          <p className="mt-2 text-sm text-zinc-500">
            No SOP matches <span className="font-mono text-zinc-400">{id}</span>. It may have been
            deleted or renamed.
          </p>
        </div>
      )}

      {state === 'error' && (
        <div className="rounded border border-red-900/40 bg-red-950/30 p-6 text-sm text-red-200">
          Could not load this SOP. Try again in a moment.
        </div>
      )}

      {state === 'ok' && sop && (
        <article>
          <header className="mb-5 border-b border-zinc-800 pb-4">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-2xl font-semibold text-zinc-100">{sop.name}</h1>
              <span className="mt-1 shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
                v{sop.version}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-500">
              <span className="font-mono">{sop.slug}</span>
              {sop.department && <span>&middot; {sop.department}</span>}
              {sop.role && <span>&middot; {sop.role}</span>}
              {sop.source && <span>&middot; source: {sop.source}</span>}
              {sop.deleted_at && <span className="text-red-400">&middot; deleted</span>}
            </div>
            {sop.description && (
              <p className="mt-3 text-sm leading-relaxed text-zinc-300">{sop.description}</p>
            )}
          </header>

          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Steps</h2>
            {steps.length > 0 ? (
              <ol className="ml-4 list-decimal space-y-2 text-sm text-zinc-200">
                {steps.map((s, i) => (
                  <li key={i}>
                    <span className="font-medium">{s.name}</span>
                    {s.checklist && s.checklist.length > 0 && (
                      <ul className="ml-4 mt-1 list-disc text-xs text-zinc-500">
                        {s.checklist.map((c, j) => (
                          <li key={j}>{c}</li>
                        ))}
                      </ul>
                    )}
                    {s.success_criteria && (
                      <p className="ml-1 mt-1 text-xs text-zinc-400">
                        <span className="text-zinc-500">Done when:</span> {s.success_criteria}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm italic text-zinc-500">No steps recorded for this SOP.</p>
            )}
          </section>

          {sop.success_criteria && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Success criteria
              </h2>
              <p className="text-sm leading-relaxed text-zinc-300">{sop.success_criteria}</p>
            </section>
          )}

          {hints.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Persona hints
              </h2>
              <div className="flex flex-wrap gap-2">
                {hints.map((h, i) => (
                  <span
                    key={i}
                    className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300"
                  >
                    {h}
                  </span>
                ))}
              </div>
            </section>
          )}

          <footer className="mt-8 border-t border-zinc-800 pt-3 text-xs text-zinc-600">
            Created {new Date(sop.created_at).toLocaleString()} &middot; updated{' '}
            {new Date(sop.updated_at).toLocaleString()}
          </footer>
        </article>
      )}
    </div>
  );
}
