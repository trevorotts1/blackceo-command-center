/**
 * /owner-login — the data-free owner sign-in landing (SPEC S7 line 277).
 *
 * What this page is NOT: there is no server component reading a database, no
 * company name, no agent, no task, no count, no feed. Before authentication the
 * page contains no company data at all, and it fetches none. Its whole job is
 * to take the `#ticket=` fragment off a private operator-minted link, drop that
 * fragment from history, and let the owner press one explicit button.
 *
 * The fragment is used rather than a query on purpose: a fragment is never sent
 * to a server, so the capability does not land in an access log or a Referer.
 * It is stripped immediately on mount with history.replaceState. The button is
 * an explicit sign-in, not an approval-to-work gate.
 *
 * Everything the browser needs is inline here: no analytics, no third-party
 * resource, no external script, no font fetch. The only network call this page
 * ever makes is the same-origin POST to /api/auth/owner-session, and only after
 * the owner presses the button.
 *
 * React structure is deliberate, not incidental: the mount effect reads the URL
 * and writes to a ref and to history — it never calls setState. Every render
 * comes from a user event. That keeps the fragment handling out of React's
 * reconciler entirely (nothing about a sign-in capability should depend on
 * render ordering) and keeps this file free of effect-driven cascades.
 *
 * A04 registers the middleware bootstrap exemption that lets this GET be served
 * before generic Access/session enforcement, and lets the POST redeem without
 * an existing apiTenant. The page itself is deliberately inert until then.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'signing-in' | 'signed-in' | 'error';

/** Only /hq is ever navigated to, and only on a server-confirmed success. */
const DESTINATION = '/hq';

const MESSAGES: Record<string, string> = {
  owner_no_ticket: 'Open the private link your operator gave you, then press Sign in.',
  owner_origin_mismatch: 'This link was not opened from your configured Headquarters address. Open it again from the address your operator gave you.',
  owner_origin_unconfigured: 'This installation has no configured public address yet, so sign-in cannot be verified. Ask your operator to finish setup.',
  owner_antiforgery_missing: 'Your browser did not send the sign-in cookie this page issues. Reload this page and press Sign in again.',
  owner_ticket_invalid: 'This sign-in link is not valid, or it has expired. Links work for ten minutes and only once — ask your operator for a fresh link.',
  owner_ticket_used: 'This sign-in link has already been used. Ask your operator for a fresh link.',
  identity_switch_requires_signout: 'You are already signed in as a different person. Sign out first, then open this link again. Sessions are never merged automatically.',
  owner_bearer_not_accepted: 'This request carried a server credential, not a browser sign-in. Open the link in a browser.',
  owner_session_unavailable: 'Sign-in is temporarily unavailable on this installation. Try again in a moment.',
};

export default function OwnerLoginPage() {
  const ticketRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);

  // Read the `#ticket=` fragment, then remove it immediately. `replaceState`
  // rather than pushState: the capability must not survive in back/forward
  // history. Refs and history only — no setState here, by design.
  useEffect(() => {
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const ticket = new URLSearchParams(raw).get('ticket');
    if (ticket) ticketRef.current = ticket;
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const fail = useCallback((code: string) => {
    // Whatever went wrong, the ticket is spent or unusable: forget the local
    // copy rather than inviting a second press of the same dead capability.
    ticketRef.current = null;
    setMessage(MESSAGES[code] ?? MESSAGES.owner_session_unavailable);
    setPhase('error');
  }, []);

  const signIn = useCallback(async () => {
    if (phase === 'signing-in' || phase === 'signed-in') return;
    // Fall back to the live URL, so the button still works if the effect has
    // not yet run (a fast press on a slow mount).
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const ticket = ticketRef.current ?? new URLSearchParams(raw).get('ticket');
    if (!ticket) {
      fail('owner_no_ticket');
      return;
    }
    setPhase('signing-in');
    setMessage(null);
    try {
      const response = await fetch('/api/auth/owner-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Body is `{ticket}` and nothing else. No next, no returnTo, no target.
        body: JSON.stringify({ ticket }),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        let code = 'owner_session_unavailable';
        try {
          const body = (await response.json()) as { error?: string };
          if (typeof body?.error === 'string' && MESSAGES[body.error]) code = body.error;
        } catch {
          /* keep the generic message */
        }
        fail(code);
        return;
      }
      const body = (await response.json()) as { redirectTo?: string };
      // The destination is a CONSTANT. A server field that disagrees is a
      // defect, not a redirect instruction: never follow a caller-controlled
      // target out of this page.
      if (body?.redirectTo !== DESTINATION) {
        fail('owner_session_unavailable');
        return;
      }
      ticketRef.current = null;
      setPhase('signed-in');
      window.location.replace(DESTINATION);
    } catch {
      fail('owner_session_unavailable');
    }
  }, [phase, fail]);

  return (
    <main className="owner-login">
      <style>{`
        .owner-login {
          min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center;
          background: #0f1115; color: #e8eaed;
          font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          padding: 24px; box-sizing: border-box;
        }
        .owner-login__card {
          width: 100%; max-width: 420px; background: #171a20; border: 1px solid #262b34;
          border-radius: 12px; padding: 32px 28px; box-shadow: 0 12px 32px rgba(0,0,0,0.35);
        }
        .owner-login__title { margin: 0 0 8px; font-size: 20px; font-weight: 600; letter-spacing: 0.01em; }
        .owner-login__lede { margin: 0 0 24px; color: #a6adb9; font-size: 14px; }
        .owner-login__button {
          width: 100%; padding: 12px 16px; font-size: 15px; font-weight: 600;
          color: #0f1115; background: #e8eaed; border: 1px solid transparent; border-radius: 8px;
          cursor: pointer;
        }
        .owner-login__button:hover:not(:disabled) { background: #ffffff; }
        .owner-login__button:disabled { opacity: 0.55; cursor: default; }
        .owner-login__button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
        .owner-login__notice { margin: 18px 0 0; font-size: 14px; color: #ffb4a8; }
        .owner-login__hint { margin: 18px 0 0; font-size: 13px; color: #a6adb9; }
        @media (prefers-color-scheme: light) {
          .owner-login { background: #f5f6f8; color: #12151a; }
          .owner-login__card { background: #ffffff; border-color: #dfe3e9; box-shadow: 0 8px 24px rgba(16,24,40,0.08); }
          .owner-login__lede { color: #5a6472; }
          .owner-login__button { color: #ffffff; background: #12151a; }
          .owner-login__button:hover:not(:disabled) { background: #000000; }
          .owner-login__notice { color: #b42318; }
          .owner-login__hint { color: #5a6472; }
        }
        @media (prefers-reduced-motion: reduce) { .owner-login__button { transition: none; } }
      `}</style>

      <div className="owner-login__card">
        <h1 className="owner-login__title">Sign in to Headquarters</h1>
        <p className="owner-login__lede">
          {phase === 'error'
            ? 'That sign-in link could not be completed.'
            : 'Open the private link your operator gave you, then press Sign in.'}
        </p>

        <button
          type="button"
          className="owner-login__button"
          onClick={signIn}
          disabled={phase === 'signing-in' || phase === 'signed-in'}
        >
          {phase === 'signing-in' ? 'Signing in…' : phase === 'signed-in' ? 'Signed in' : 'Sign in'}
        </button>

        {message ? (
          <p className="owner-login__notice" role="alert">{message}</p>
        ) : null}

        <p className="owner-login__hint">
          Sign-in links work once and expire after ten minutes. If yours has expired, ask your operator for a fresh one.
        </p>
      </div>
    </main>
  );
}
