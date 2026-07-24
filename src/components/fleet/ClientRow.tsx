'use client';

/**
 * ClientRow — a per-client status card for the /fleet dashboard (U009).
 * Renders a quiet hairline card showing the client name, a self-indicator,
 * and a dense 2x2 cluster of four labeled signals: interview progress,
 * gateway liveness, health, and pipeline stage.
 *
 * Design language mirrors /overview's calm density: hairline borders,
 * semantic tones via StatusBadge, no brand hues. Every signal is
 * self-explanatory via a tiny muted caption so the card reads at a glance.
 */

import type { FleetClientStatus } from '@/lib/fleet';

import { StatusBadge } from './StatusBadge';
import type { StatusTone } from './StatusBadge';

// ---------------------------------------------------------------------------
// Interview helpers
// ---------------------------------------------------------------------------

const INTERVIEW_MAP: Record<
  FleetClientStatus['interview'],
  { tone: StatusTone; label: string }
> = {
  complete: { tone: 'ok', label: 'Complete' },
  'in-progress': { tone: 'info', label: 'In progress' },
  'not-started': { tone: 'neutral', label: 'Not started' },
};

// ---------------------------------------------------------------------------
// Liveness helpers
// ---------------------------------------------------------------------------

const LIVENESS_MAP: Record<
  FleetClientStatus['liveness'],
  { tone: StatusTone; label: string }
> = {
  live: { tone: 'ok', label: 'Live' },
  offline: { tone: 'error', label: 'Offline' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

// ---------------------------------------------------------------------------
// Health helpers
// ---------------------------------------------------------------------------

const HEALTH_MAP: Record<
  FleetClientStatus['health'],
  { tone: StatusTone; label: string }
> = {
  ok: { tone: 'ok', label: 'Healthy' },
  error: { tone: 'error', label: 'Degraded' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ClientRowProps {
  client: FleetClientStatus;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClientRow({ client, className }: ClientRowProps) {
  const interview = INTERVIEW_MAP[client.interview];
  const liveness = LIVENESS_MAP[client.liveness];
  const health = HEALTH_MAP[client.health];
  const stageLabel =
    client.pipelineStage.charAt(0).toUpperCase() + client.pipelineStage.slice(1);

  return (
    <div
      className={`bg-white border border-gray-200 rounded-xl p-4 ${className ?? ''}`}
    >
      {/* Header: name + self badge */}
      <div className="flex items-center gap-2 mb-3 min-w-0">
        <span className="font-semibold text-sm text-gray-900 truncate">
          {client.name}
        </span>
        {client.isSelf && (
          <StatusBadge tone="neutral" label="You" />
        )}
      </div>

      {/* 2x2 signal cluster */}
      <div className="flex flex-wrap gap-3">
        {/* Interview */}
        <div className="flex flex-col gap-1">
          <StatusBadge
            tone={interview.tone}
            label={interview.label}
          />
          {client.interviewDetail && (
            <span className="text-[11px] text-gray-400 leading-tight">
              {client.interviewDetail}
            </span>
          )}
        </div>

        {/* Gateway liveness */}
        <div className="flex flex-col gap-1">
          <StatusBadge
            tone={liveness.tone}
            label={liveness.label}
            pulse={client.liveness === 'live'}
          />
          <span className="text-[11px] text-gray-400 leading-tight">
            Gateway
          </span>
        </div>

        {/* Health */}
        <div className="flex flex-col gap-1">
          <StatusBadge
            tone={health.tone}
            label={health.label}
          />
          <span className="text-[11px] text-gray-400 leading-tight">
            Health
          </span>
        </div>

        {/* Pipeline stage */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-gray-400 leading-tight">
            Pipeline
          </span>
          <span className="font-mono text-xs text-gray-700 tabular-nums">
            {stageLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
