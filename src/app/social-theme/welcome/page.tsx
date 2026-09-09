'use client';

/**
 * /social-theme/welcome — F27 entry screen.
 *
 * Reads the raw invitation ticket from the URL hash/query, exchanges it once
 * for the scoped HttpOnly session cookie (POST /api/social-theme/exchange),
 * then IMMEDIATELY strips the raw token from the address bar
 * (history.replaceState) per the SPEC contract: "Remove the raw token from
 * the browser address afterward". On expiry the client is told their saved
 * answers are intact and pointed to the renew path in their assistant
 * conversation (browser-recovery pattern).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const RENEW_HELP =
  'This link has expired or was already used. Your saved answers are still there. In your conversation with your assistant, say “renew my social plan link” for a fresh private link — it opens this same week with everything you saved.';

export default function SocialThemeWelcomePage() {
  const [state, setState] = useState<'exchanging' | 'ready' | 'expired' | 'error'>('exchanging');
  const [message, setMessage] = useState('');
  const startedRef = useRef(false);

  const exchange = useCallback(async (ticket: string) => {
    try {
      const res = await fetch('/api/social-theme/exchange', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      if (res.ok) {
        // Strip the raw token from the URL/history BEFORE navigating on.
        try {
          window.history.replaceState(null, '', '/social-theme');
        } catch { /* older browsers: token still expires server-side */ }
        setState('ready');
        return;
      }
      if (res.status === 403) {
        setState('expired');
        setMessage(RENEW_HELP);
        return;
      }
      if (res.status === 429) {
        setState('error');
        setMessage('Too many attempts. Wait a few minutes and open the newest link.');
        return;
      }
      setState('error');
      setMessage('Could not open your plan right now. Retry the link in a moment.');
    } catch {
      setState('error');
      setMessage('Could not reach your plan right now. Retry the link when back online.');
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('ticket') || '';
    if (!ticket) {
      // No ticket: maybe an already-exchanged session on this device.
      (async () => {
        try {
          const res = await fetch('/api/social-theme/session', { credentials: 'include', cache: 'no-store' });
          if (res.ok) setState('ready');
          else { setState('expired'); setMessage(RENEW_HELP); }
        } catch {
          setState('expired');
          setMessage(RENEW_HELP);
        }
      })();
      return;
    }
    void exchange(ticket);
  }, [exchange]);

  if (state === 'exchanging') {
    return <main style={page}><p>Opening your private plan…</p></main>;
  }

  if (state === 'ready') {
    return (
      <main style={page}>
        <h1 style={h1}>You&apos;re in</h1>
        <p>Your link is activated and this device is signed in for this week&apos;s plan.</p>
        <a href="/social-theme" data-testid="enter-planner" style={btnPrimary}>Open my weekly plan</a>
      </main>
    );
  }

  if (state === 'expired') {
    return (
      <main style={page}>
        <h1 style={h1}>Link expired</h1>
        <p data-testid="renew-help">{message}</p>
      </main>
    );
  }

  return (
    <main style={page}>
      <h1 style={h1}>Something went wrong</h1>
      <p>{message}</p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>{RENEW_HELP}</p>
    </main>
  );
}

const page: React.CSSProperties = { maxWidth: 640, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' };
const h1: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 600 };
const btnPrimary: React.CSSProperties = { display: 'inline-block', padding: '0.55rem 1.1rem', borderRadius: 6, border: '1px solid #16a34a', background: '#16a34a', color: '#fff', cursor: 'pointer', textDecoration: 'none' };