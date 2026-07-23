'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

async function isInterviewComplete(): Promise<boolean> {
  try {
    const r = await fetch('/api/interview/state', { cache: 'no-store' });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.interviewComplete === true || d.buildCompleted === true;
  } catch { return false; }
}

export default function InterviewBypassBanner() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  useEffect(() => { let c = false; void (async () => { const v = !(await isInterviewComplete()); if (!c) setVisible(v); })(); return () => { c = true; }; }, []);
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
