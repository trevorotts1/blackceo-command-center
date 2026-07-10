'use client';

/**
 * The Anthology board card FACE (SPEC B11 / Unit U12), rendered inside the
 * existing TaskCard for `task.source === 'anthology'` cards only — every
 * non-anthology card is untouched. It surfaces, from data the card already
 * carries (see anthology-card.ts), the four things a producer wants at a glance:
 *
 *   • participant name + book-id chip
 *   • a 9-segment S0 → S9 progress bar
 *   • a stage badge ("S2 · Tone")
 *   • an age line ("waiting on you for 2 days") while the card is in Review
 *
 * Producer voice throughout: the doers are "editors", never "AI".
 */

import { BookOpen, Clock, AlertTriangle } from 'lucide-react';
import {
  parseAnthologyCard,
  waitingAge,
  TOTAL_SEGMENTS,
  type AnthologyTaskLike,
} from './anthology-card';

export function AnthologyCardFace({ task }: { task: AnthologyTaskLike }) {
  const card = parseAnthologyCard(task);
  if (!card) return null;

  const age = waitingAge(task);
  const stage = card.stage;
  const filled = stage && stage.index !== null ? stage.index : 0;
  const exceptional = !!stage?.exceptional;

  return (
    <div className="mb-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 space-y-2">
      {/* Name + book chip */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900 truncate">
          {card.isAssembly ? 'Assembly' : card.displayName || 'Participant'}
        </span>
        {card.bookId && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-white text-indigo-700 border border-indigo-100 shrink-0 max-w-[55%] truncate"
            title={`Book: ${card.bookId}`}
          >
            <BookOpen className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{card.bookId}</span>
          </span>
        )}
      </div>

      {/* Stage badge + 9-segment S0→S9 bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          {stage ? (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${
                exceptional ? 'bg-amber-100 text-amber-800' : 'bg-indigo-600 text-white'
              }`}
            >
              {exceptional && <AlertTriangle className="w-3 h-3" aria-hidden="true" />}
              {stage.badge}
            </span>
          ) : (
            <span className="text-[11px] font-medium text-gray-400">Stage pending</span>
          )}
          {stage && !exceptional && (
            <span className="text-[11px] font-medium text-gray-500">
              {stage.index} of {TOTAL_SEGMENTS}
            </span>
          )}
        </div>

        <div
          className="flex items-center gap-1"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={TOTAL_SEGMENTS}
          aria-valuenow={filled}
          aria-label={
            stage ? `Stage ${stage.badge} of ${TOTAL_SEGMENTS}` : 'Stage progress'
          }
        >
          {Array.from({ length: TOTAL_SEGMENTS }).map((_, k) => (
            <span
              key={k}
              className={`h-1.5 flex-1 rounded-full ${
                exceptional
                  ? 'bg-amber-200'
                  : k < filled
                    ? 'bg-indigo-500'
                    : 'bg-indigo-100'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Age — only while the card sits in the producer's Review queue */}
      {age && (
        <div className="flex items-center gap-1 text-[11px] font-medium text-indigo-700">
          <Clock className="w-3 h-3" aria-hidden="true" />
          <span className="capitalize">{age}</span>
        </div>
      )}
    </div>
  );
}
