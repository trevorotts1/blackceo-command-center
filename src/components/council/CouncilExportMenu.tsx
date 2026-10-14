'use client';

/**
 * CouncilExportMenu (CWE-034, Skill 77) - Section 21's ExportMenu.
 *
 * Shows the available / queued / failed download states for the
 * validated report formats (Section 24: Markdown, JSON, PDF, all
 * generated from the same validated verdict revision). The export
 * service is owned by CWE-038 and is not wired in this build: the
 * typed FEATURE_NOT_READY answer renders as an explicit not-ready
 * state naming the owning unit, never as a fake download.
 *
 * Exports initiated from a replay carry the replay label in the
 * request and on the menu itself (T101): a replay export can never
 * pass as a live-session export.
 */

import { useState } from 'react';
import { council, councilcx } from './council-theme';
import {
  CouncilApiClientError,
  type CouncilExportRequest,
} from './council-session-client';
import type { CouncilRoomMode } from './council-room-types';

export type CouncilExportFormat = 'markdown' | 'json' | 'pdf';

type ExportState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'recorded'; note: string }
  | { kind: 'not_ready'; message: string }
  | { kind: 'failed'; message: string };

export interface CouncilExportMenuProps {
  sessionId: string;
  mode: CouncilRoomMode;
  createExport: (
    body: CouncilExportRequest,
    idempotencyKey: string,
  ) => Promise<Record<string, unknown>>;
  makeIdempotencyKey?: (format: CouncilExportFormat) => string;
}

const FORMAT_LABELS: ReadonlyArray<{ format: CouncilExportFormat; label: string }> = [
  { format: 'markdown', label: 'Markdown' },
  { format: 'json', label: 'JSON' },
  { format: 'pdf', label: 'PDF' },
];

export function CouncilExportMenu({
  sessionId,
  mode,
  createExport,
  makeIdempotencyKey,
}: CouncilExportMenuProps) {
  const [states, setStates] = useState<Partial<Record<CouncilExportFormat, ExportState>>>({});
  const replay = mode === 'replay';

  const runExport = async (format: CouncilExportFormat) => {
    setStates((prev) => ({ ...prev, [format]: { kind: 'requesting' } }));
    const key =
      makeIdempotencyKey?.(format) ??
      `council-export-${sessionId}-${format}-${Date.now()}`;
    try {
      const record = await createExport(
        { session_id: sessionId, format, replay },
        key,
      );
      const status =
        typeof record.status === 'string' ? record.status : 'recorded';
      const downloadUrl =
        typeof record.download_url === 'string' ? record.download_url : null;
      setStates((prev) => ({
        ...prev,
        [format]: {
          kind: 'recorded',
          note: downloadUrl
            ? `Ready: ${downloadUrl}`
            : `Export recorded with status "${status}". No download link was returned by the export service.`,
        },
      }));
    } catch (error) {
      if (error instanceof CouncilApiClientError && error.isFeatureNotReady) {
        setStates((prev) => ({
          ...prev,
          [format]: { kind: 'not_ready', message: error.message },
        }));
      } else {
        setStates((prev) => ({
          ...prev,
          [format]: {
            kind: 'failed',
            message:
              error instanceof Error
                ? error.message
                : 'The export request failed.',
          },
        }));
      }
    }
  };

  return (
    <div data-testid="council-export-menu">
      <h3 className={council.heading}>
        Export this verdict{replay ? ' (recorded replay)' : ''}
      </h3>
      {replay ? (
        <p className={council.meta} data-testid="council-export-replay-note">
          This session is a recorded replay. Any export created here is
          labeled as a replay export and cannot create production work.
        </p>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {FORMAT_LABELS.map(({ format, label }) => {
          const state = states[format] ?? { kind: 'idle' as const };
          return (
            <span key={format} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                className={councilcx(council.btn, council.btnSecondary)}
                data-testid={`council-export-${format}`}
                disabled={state.kind === 'requesting'}
                onClick={() => void runExport(format)}
              >
                {label}
                {replay ? ' (replay)' : ''}
              </button>
              <span
                className={council.meta}
                data-testid={`council-export-${format}-state`}
                aria-live="polite"
              >
                {state.kind === 'requesting'
                  ? 'Requesting...'
                  : state.kind === 'recorded'
                    ? state.note
                    : state.kind === 'not_ready'
                      ? 'Not available yet: the export service (CWE-038) is not wired. No file was created.'
                      : state.kind === 'failed'
                        ? `Export failed: ${state.message}`
                        : 'Available when the export service is wired.'}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
