'use client';

import { useCallback, useEffect, useState, type SetStateAction } from 'react';

const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Local drafts never become submitted answers or use an unverified scope. */
export function useInterviewDraft(scope: string | null | undefined, field: string, initial = '') {
  const key = scope ? `iv-draft:${encodeURIComponent(scope)}:${encodeURIComponent(field)}` : null;
  const [draft, setDraft] = useState({ key, value: initial });
  const [available, setAvailable] = useState(true);
  const value = draft.key === key ? draft.value : initial;

  useEffect(() => {
    let restored = initial;
    try {
      if (key) {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved && typeof saved.value === 'string' && Number.isFinite(saved.at)
          && Date.now() - saved.at >= 0 && Date.now() - saved.at < MAX_DRAFT_AGE_MS) restored = saved.value;
        else localStorage.removeItem(key);
      }
      setAvailable(true);
    } catch { setAvailable(false); }
    setDraft({ key, value: restored });
  }, [key, initial]);

  const update = useCallback((next: SetStateAction<string>) => {
    const updated = typeof next === 'function' ? next(value) : next;
    setDraft({ key, value: updated });
    try {
      if (key) {
        if (updated) localStorage.setItem(key, JSON.stringify({ value: updated, at: Date.now() }));
        else localStorage.removeItem(key);
      }
      setAvailable(true);
    } catch { setAvailable(false); }
  }, [key, value]);

  const clear = useCallback(() => {
    try { if (key) localStorage.removeItem(key); } catch { /* answer is already saved */ }
  }, [key]);
  return [value, update, clear, !!key && available] as const;
}
