'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `null` means the browser could not read the interview state. Access failures
 * must never be presented to an owner as an incomplete interview: completion
 * is established by the server's canonical build record, not by a failed UI
 * status request.
 */
async function getInterviewCompletion(): Promise<boolean | null> {
  try {
    const r = await fetch('/api/interview/state', { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || typeof d !== 'object') return null;
    return d.interviewComplete === true || d.buildCompleted === true;
  } catch { return null; }
}

export default function InterviewBypassBanner() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const completion = await getInterviewCompletion();
      // Only a successful, explicit `false` can show this warning. A 401,
      // timeout, or malformed response is an access problem, not evidence
      // that someone lost their completed interview.
      if (!cancelled) setVisible(completion === false);
    })();
    return () => { cancelled = true; };
  }, []);
  if (!visible) return null;
  return (
    <div role="alert" aria-live="polite" data-walkthrough="interview-bypass-banner"
      style={{ position:'fixed',top:0,left:0,right:0,zIndex:100,
        background:'var(--iv-accent-strong,#f2b134)',color:'var(--iv-accent-ink,#1c1c22)',
        padding:'0.55rem 1rem',display:'flex',alignItems:'center',justifyContent:'center',
        gap:'0.6rem',fontSize:'0.85rem',fontWeight:600,boxShadow:'0 1px 6px rgba(0,0,0,0.15)' }}>
      <span>Your AI Workforce Interview is not yet complete.</span>
      <button type="button" onClick={() => router.push('/interview')}
        style={{ background:'rgba(0,0,0,0.12)',border:'none',borderRadius:'6px',
          padding:'0.25rem 0.6rem',cursor:'pointer',fontWeight:600,fontSize:'inherit',color:'inherit' }}>
        Finish it now
      </button>
      <button type="button" onClick={() => setVisible(false)} aria-label="Dismiss"
        style={{ background:'none',border:'none',borderRadius:'4px',padding:'0.15rem',
          cursor:'pointer',color:'inherit',marginLeft:'0.25rem' }}>
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
