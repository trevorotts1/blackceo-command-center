'use client';

/**
 * Collects the 3 human-only fields PATCH /api/tasks/[id] requires whenever a
 * task's status moves to 'blocked' (see the "Blocked-column gate" in that
 * route — blocked_reason, blocked_on_human, ask). Before this existed,
 * dropping a card on the Blocked column PATCHed {status:'blocked'} with none
 * of those fields, which the API always 400'd ("Blocked requires a
 * human-only reason") — so the Blocked column was silently unreachable via
 * drag-drop. MissionQueue now opens this modal instead of PATCHing
 * immediately; on confirm it PATCHes with the collected fields, on cancel it
 * reverts the optimistic move.
 */

import { useState } from 'react';
import { X } from 'lucide-react';

export const BLOCKED_REASONS: { value: string; label: string }[] = [
  { value: 'decision', label: 'Decision needed' },
  { value: 'approval', label: 'Approval needed' },
  { value: 'credential', label: 'Credential needed' },
  { value: 'payment', label: 'Payment needed' },
];

export const BLOCKED_AUDIENCES: { value: string; label: string }[] = [
  { value: 'owner', label: 'Owner (client)' },
  { value: 'operator', label: 'Operator (internal)' },
];

export interface BlockTaskDetails {
  blocked_reason: string;
  blocked_on_human: string;
  ask: string;
}

interface BlockTaskModalProps {
  taskTitle: string;
  onConfirm: (details: BlockTaskDetails) => void;
  onCancel: () => void;
}

export function BlockTaskModal({ taskTitle, onConfirm, onCancel }: BlockTaskModalProps) {
  const [reason, setReason] = useState('');
  const [audience, setAudience] = useState('');
  const [ask, setAsk] = useState('');
  const [touched, setTouched] = useState(false);

  const isValid = !!reason && !!audience && ask.trim().length > 0;

  const handleConfirm = () => {
    setTouched(true);
    if (!isValid) return;
    onConfirm({ blocked_reason: reason, blocked_on_human: audience, ask: ask.trim() });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Move to Blocked</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel move to blocked"
            className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          <p className="text-sm text-gray-500">
            The Blocked column is only for tasks waiting on a human action. Tell us what{' '}
            <span className="font-medium text-gray-700">&ldquo;{taskTitle}&rdquo;</span> needs before it can move.
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              <option value="">Select a reason...</option>
              {BLOCKED_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Who is needed?</label>
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              <option value="">Select...</option>
              {BLOCKED_AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What do you need?</label>
            <textarea
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              rows={3}
              required
              placeholder="One line stating exactly what the human must do"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            />
          </div>

          {touched && !isValid && (
            <p className="text-xs text-red-600">Reason, audience, and ask are all required to move a task to Blocked.</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
          >
            Move to Blocked
          </button>
        </div>
      </div>
    </div>
  );
}
