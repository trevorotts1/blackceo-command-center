'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';

/** "N approvals waiting" — links to /approvals. Hidden when nothing waits or the count cannot be read. */
export function ApprovalsBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/approval-requests?status=pending', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { pending_count?: number };
        if (alive && typeof body.pending_count === 'number') setCount(body.pending_count);
      } catch { /* leave the last known count */ }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (count < 1) return null;
  const label = `${count} approval${count === 1 ? '' : 's'} waiting`;
  return (
    <Link
      href="/approvals"
      aria-label={label}
      title={label}
      data-testid="approvals-badge"
      className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 hover:bg-amber-100 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
    >
      <Inbox className="w-4 h-4" />
      <span>{label}</span>
    </Link>
  );
}
