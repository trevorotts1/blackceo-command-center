'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * src/components/social-theme/useThemeDraft.ts — F27 autosave hook.
 *
 * SPEC mini-app screens contract:
 *   - debounce changes ~750 ms and save immediately on blur/step navigation;
 *   - visibly show Saving / Saved / Retry needed;
 *   - retain unsent text locally in a company/session-scoped cache, expire on
 *     the retention window, and reconcile revisions after connectivity
 *     returns;
 *   - NEVER rely on page-unload delivery (no beforeunload sends).
 *
 * Revision currency: every PATCH carries expectedRevision (the last server
 * revision this tab knows). A 409 returns the server's row; the second-device
 * conflict resolution is left to the human — the hook exposes `conflict`
 * state and `applyServerAnswers` / `keepMineAndResubmit` instead of picking
 * a side silently.
 */

export type SaveState = 'idle' | 'saving' | 'saved' | 'retry' | 'conflict';

export interface ServerDraft {
  revision: number;
  answers: Record<string, string>;
  saved_at: string | null;
}

const LOCAL_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // expire on retention horizon

function cacheKey(companyId: string, sessionId: string, field: string): string | null {
  if (!companyId || !sessionId) return null;
  return `st-draft:${encodeURIComponent(companyId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(field)}`;
}

export interface UseThemeDraftOptions {
  companyId: string;
  sessionId: string;
  /** Debounce ms; SPEC target ~750. */
  debounceMs?: number;
  /** Called when the hook needs the freshest server revision (conflict path). */
  onConflict?: (server: ServerDraft) => void;
}

export interface ThemeDraftField {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  saveNow: () => Promise<void>;
}

export function useThemeDraftCore(
  initialAnswers: Record<string, string>,
  initialRevision: number,
  options: UseThemeDraftOptions,
) {
  const { companyId, sessionId, debounceMs = 750 } = options;
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  const [revision, setRevision] = useState(initialRevision);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<ServerDraft | null>(null);
  const dirtyRef = useRef<Record<string, string>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef(initialRevision);
  const answersRef = useRef(initialAnswers);
  const saveQueueRef = useRef<Promise<number | null>>(Promise.resolve(initialRevision));
  const conflictRef = useRef<ServerDraft | null>(null);

  // Local unsent cache per field (company/session-scoped).
  const cacheLocal = useCallback((field: string, value: string | null) => {
    const key = cacheKey(companyId, sessionId, field);
    if (!key) return;
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
    } catch { /* storage unavailable — server autosave still owns durability */ }
  }, [companyId, sessionId]);

  const flush = useCallback((): Promise<number | null> => {
    const pending = saveQueueRef.current.then(async (): Promise<number | null> => {
      if (conflictRef.current) return null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const dirty = dirtyRef.current;
      if (!Object.keys(dirty).length) return revisionRef.current;
      dirtyRef.current = {};
      setSaveState('saving');
      try {
        const res = await fetch('/api/social-theme/session', {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answers: dirty, expected_revision: revisionRef.current }),
        });
        if (res.status === 409) {
          const body = (await res.json()) as { server?: ServerDraft };
          setSaveState('conflict');
          dirtyRef.current = { ...dirty, ...dirtyRef.current };
          conflictRef.current = body.server || { revision: revisionRef.current, answers: answersRef.current, saved_at: null };
          setConflict(conflictRef.current);
          options.onConflict?.(conflictRef.current);
          return null;
        }
        if (!res.ok) {
          // Put the fields back in the dirty set — retry needed, nothing lost.
          dirtyRef.current = { ...dirty, ...dirtyRef.current };
          setSaveState('retry');
          return null;
        }
        const body = (await res.json()) as { revision: number; saved_at: string | null };
        revisionRef.current = body.revision;
        setRevision(body.revision);
        setSaveState('saved');
        for (const field of Object.keys(dirty)) {
          if (!(field in dirtyRef.current)) cacheLocal(field, null);
        }
        return body.revision;
      } catch {
        dirtyRef.current = { ...dirty, ...dirtyRef.current };
        setSaveState('retry');
        return null;
      }
    });
    saveQueueRef.current = pending;
    return pending;
  }, [cacheLocal, options]);

  const onChange = useCallback((field: string, next: string) => {
    setAnswers((prev) => {
      const updated = { ...prev, [field]: next };
      answersRef.current = updated;
      return updated;
    });
    dirtyRef.current[field] = next;
    cacheLocal(field, next);
    setSaveState((s) => (s === 'conflict' ? 'conflict' : 'idle'));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, debounceMs);
  }, [cacheLocal, debounceMs, flush]);

  const onBlur = useCallback(() => { void flush(); }, [flush]);
  const saveNow = flush;

  // Reconcile after connectivity returns: a 'retry' state flushes when the
  // browser reports back online.
  useEffect(() => {
    const onOnline = () => {
      if (saveState === 'retry') void flush();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flush, saveState]);

  // Restore any locally cached unsent values the server draft doesn't have.
  useEffect(() => {
    try {
      for (const field of Object.keys(initialAnswers)) {
        const key = cacheKey(companyId, sessionId, field);
        if (!key) continue;
        const saved = JSON.parse(localStorage.getItem(key) || 'null') as { value: string; at: number } | null;
        if (saved && typeof saved.value === 'string' && Date.now() - saved.at >= 0 && Date.now() - saved.at < LOCAL_CACHE_TTL_MS) {
          if (!(field in initialAnswers)) {
            setAnswers((prev) => ({ ...prev, [field]: saved.value }));
          }
        } else if (saved) {
          localStorage.removeItem(key);
        }
      }
    } catch { /* ignore malformed cache */ }
  }, [companyId, sessionId]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const applyServerAnswers = useCallback((server: ServerDraft) => {
    revisionRef.current = server.revision;
    setRevision(server.revision);
    setAnswers(server.answers);
    answersRef.current = server.answers;
    dirtyRef.current = {};
    conflictRef.current = null;
    setConflict(null);
    setSaveState('saved');
  }, []);

  const keepMineAndResubmit = useCallback(async (merged: Record<string, string>) => {
    // Force-adopt our answers on top of the server revision: read the server
    // revision, then PATCH a merge with OUR values. The human already chose.
    try {
      const current = await fetch('/api/social-theme/session', { credentials: 'include', cache: 'no-store' });
      if (!current.ok) { setSaveState('retry'); return; }
      const body = (await current.json()) as { session: { revision: number } };
      revisionRef.current = body.session.revision;
      setRevision(body.session.revision);
      setSaveState('saving');
      const res = await fetch('/api/social-theme/session', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: merged, expected_revision: body.session.revision }),
      });
      if (res.ok) {
        const saved = (await res.json()) as { revision: number };
        revisionRef.current = saved.revision;
        setRevision(saved.revision);
        setAnswers(merged);
        answersRef.current = merged;
        dirtyRef.current = {};
        conflictRef.current = null;
        setConflict(null);
        setSaveState('saved');
      } else {
        setSaveState('retry');
      }
    } catch {
      setSaveState('retry');
    }
  }, []);

  return {
    answers, revision, saveState, conflict,
    onChange, onBlur, saveNow, applyServerAnswers, keepMineAndResubmit,
    setSaveState,
  };
}