'use client';

/**
 * src/components/social-theme/SaveBadge.tsx — the visible Saving / Saved /
 * Retry needed indicator (SPEC: "visibly show Saving, Saved or Retry
 * needed"). Also renders the conflict banner hook when a second-device
 * revision conflict is pending.
 */

import type { SaveState } from './useThemeDraft';

const LABEL: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  retry: 'Retry needed — your edits are kept, we will retry automatically.',
  conflict: 'Conflict — another device saved newer answers.',
};

const COLOR: Record<SaveState, string> = {
  idle: 'transparent',
  saving: '#6b7280',
  saved: '#16a34a',
  retry: '#dc2626',
  conflict: '#d97706',
};

export function SaveBadge({ state }: { state: SaveState }) {
  if (state === 'idle') return <span data-testid="save-badge" data-state={state} style={{ minHeight: 18, display: 'inline-block' }} />;
  return (
    <span
      data-testid="save-badge"
      data-state={state}
      role="status"
      style={{ color: COLOR[state], fontSize: '0.85rem', display: 'inline-block' }}
    >
      {LABEL[state]}
    </span>
  );
}

export function ConflictBanner({
  conflict,
  onUseServer,
  onKeepMine,
}: {
  conflict: { revision: number; answers: Record<string, string> } | null;
  onUseServer: () => void;
  onKeepMine: () => void;
}) {
  if (!conflict) return null;
  return (
    <div
      data-testid="conflict-banner"
      role="alertdialog"
      aria-label="Conflicting edits"
      style={{
        border: '1px solid #d97706',
        borderRadius: 8,
        padding: '0.9rem 1rem',
        margin: '0.75rem 0',
        background: '#fffbeb',
      }}
    >
      <strong>Another device saved newer answers</strong>
      <p style={{ margin: '0.4rem 0', color: '#444' }}>
        Your edits here and the other device&apos;s edits are both preserved. Choose which to keep:
      </p>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button type="button" onClick={onUseServer} style={{ padding: '0.45rem 0.9rem', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer' }}>
          Use the other device&apos;s answers
        </button>
        <button type="button" onClick={onKeepMine} style={{ padding: '0.45rem 0.9rem', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer' }}>
          Keep my edits
        </button>
      </div>
    </div>
  );
}