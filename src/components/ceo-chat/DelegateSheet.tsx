'use client';

/**
 * DelegateSheet (U60 / JM-U63d)
 *
 * The task-assign/department control's UI half. Posts to
 * `POST /api/ceo-chat/task` — department dropdown defaults to "Auto-route"
 * (first option, pre-selected); an explicit pick is NEVER floored, capped, or
 * re-routed (the route pins it exactly, spec (d)). Shows an optimistic card
 * ("Auto-routing…" / the picked department name) while the request is in
 * flight, a retry affordance on failure, and hands the resolved
 * `{taskId, department, resolved_by}` back to the parent so the Operations
 * Rail and the transcript receipt chip can render it immediately (rather than
 * waiting on the next history poll).
 */
import { useEffect, useState } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import type { DepartmentOption } from './types';

interface DelegateResult {
  taskId: string;
  department: string;
  resolved_by: string;
}

interface DelegateSheetProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  onDelegated: (result: DelegateResult) => void;
}

const AUTO_VALUE = 'auto';

export default function DelegateSheet({ open, onClose, sessionId, onDelegated }: DelegateSheetProps) {
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [departmentSlug, setDepartmentSlug] = useState<string>(AUTO_VALUE);
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/departments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.success) setDepartments(data.departments ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || phase === 'submitting') return;
    setPhase('submitting');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/ceo-chat/task', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          title: trimmed,
          detail: detail.trim() || undefined,
          departmentSlug: departmentSlug === AUTO_VALUE ? 'auto' : departmentSlug,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPhase('error');
        setErrorMsg(data.error || 'Could not create the task — try again.');
        return;
      }
      onDelegated({ taskId: data.taskId, department: data.department, resolved_by: data.resolved_by });
      setTitle('');
      setDetail('');
      setDepartmentSlug(AUTO_VALUE);
      setPhase('idle');
      onClose();
    } catch {
      setPhase('error');
      setErrorMsg('Could not reach the server — try again.');
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Delegate a task" data-testid="delegate-sheet">
      <div className="space-y-3">
        <div>
          <label htmlFor="delegate-title" className="block text-label text-bcc-text-secondary mb-1">
            What needs doing?
          </label>
          <input
            id="delegate-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Follow up with the lead from this morning"
            className="w-full h-11 rounded-xl border border-bcc-border px-3 text-body focus:outline-none focus:ring-2 focus:ring-brand-300"
          />
        </div>
        <div>
          <label htmlFor="delegate-detail" className="block text-label text-bcc-text-secondary mb-1">
            Details (optional)
          </label>
          <textarea
            id="delegate-detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-bcc-border px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-brand-300"
          />
        </div>
        <div>
          <label htmlFor="delegate-department" className="block text-label text-bcc-text-secondary mb-1">
            Department
          </label>
          <select
            id="delegate-department"
            value={departmentSlug}
            onChange={(e) => setDepartmentSlug(e.target.value)}
            className="w-full h-11 rounded-xl border border-bcc-border px-3 text-body bg-bcc-white focus:outline-none focus:ring-2 focus:ring-brand-300"
          >
            <option value={AUTO_VALUE}>Auto-route (let your AI CEO decide)</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.emoji} {d.name}
              </option>
            ))}
          </select>
        </div>

        {phase === 'error' && errorMsg && (
          <div className="rounded-xl border border-red-200 bg-semantic-dangerLight px-3 py-2 text-label text-red-700">
            {errorMsg}
          </div>
        )}
        {phase === 'submitting' && (
          <div className="rounded-xl border border-bcc-border bg-bcc-border-light px-3 py-2 text-label text-bcc-text-secondary">
            {departmentSlug === AUTO_VALUE ? 'Auto-routing…' : 'Creating task…'}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!title.trim() || phase === 'submitting'}
          className="w-full h-11 rounded-xl bg-brand-600 text-white font-medium text-body hover:bg-brand-700 disabled:opacity-40"
        >
          {phase === 'error' ? 'Retry' : 'Delegate'}
        </button>
      </div>
    </BottomSheet>
  );
}
