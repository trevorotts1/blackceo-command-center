'use client';

/**
 * /social-theme — the F27 weekly theme mini app root.
 *
 * Loads the session-derived draft (GET /api/social-theme/session — the
 * server derives company/cycle from the HttpOnly cookie) and renders the
 * wizard. A missing session renders the renew-help state (browser-recovery
 * pattern): saved answers are safe, the client asks their assistant
 * conversation for a fresh link.
 */

import { useEffect, useRef, useState } from 'react';
import { ThemeWizard, type WizardState } from '../../components/social-theme/ThemeWizard';

const RENEW_HELP =
  'Your saved answers are still there. In your conversation with your assistant, say “renew my social plan link” for a fresh private link.';

export default function SocialThemePage() {
  const [state, setState] = useState<'loading' | 'ready' | 'unauthorized'>('loading');
  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const res = await fetch('/api/social-theme/session', { credentials: 'include', cache: 'no-store' });
        if (res.ok) {
          setWizardState((await res.json()) as WizardState);
          setState('ready');
        } else {
          setState('unauthorized');
        }
      } catch {
        setState('unauthorized');
      }
    })();
  }, []);

  if (state === 'loading') {
    return <main style={page}><p>Loading your plan…</p></main>;
  }
  if (state === 'unauthorized' || !wizardState) {
    return (
      <main style={page}>
        <h1 style={h1}>Session needed</h1>
        <p data-testid="renew-help">{RENEW_HELP}</p>
      </main>
    );
  }
  return <ThemeWizard initial={wizardState} />;
}

const page: React.CSSProperties = { maxWidth: 720, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' };
const h1: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 600 };