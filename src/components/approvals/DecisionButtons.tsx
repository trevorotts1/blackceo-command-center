'use client';

import { useState, useTransition } from 'react';
import { submitApprovalDecision } from '@/app/approvals/actions';

export function DecisionButtons({ requestId }: { requestId: string }) {
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const send = (decision: 'approve' | 'request_changes') =>
    start(async () => {
      const r = await submitApprovalDecision(requestId, decision, note);
      setMessage(r.ok
        ? { ok: true, text: decision === 'approve' ? 'Approved. Your assistant can go ahead.' : 'Sent. Your assistant will make the changes.' }
        : { ok: false, text: r.error ?? 'That did not go through.' });
    });

  return (
    <div className="mt-6 space-y-3">
      <label className="block text-sm font-medium text-gray-700" htmlFor={`note-${requestId}`}>
        Anything you want changed? (optional for Approve)
      </label>
      <textarea
        id={`note-${requestId}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        rows={3}
        className="w-full rounded-lg border border-gray-300 p-3 text-base"
        placeholder="For example: move Tuesday's post to Wednesday."
      />
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => send('approve')}
          className="flex-1 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white text-lg font-semibold py-4 px-6"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => send('request_changes')}
          className="flex-1 rounded-xl bg-white border-2 border-gray-300 hover:bg-gray-50 disabled:opacity-60 text-gray-800 text-lg font-semibold py-4 px-6"
        >
          Request changes
        </button>
      </div>
      {message ? (
        <p role="status" className={message.ok ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{message.text}</p>
      ) : null}
    </div>
  );
}
