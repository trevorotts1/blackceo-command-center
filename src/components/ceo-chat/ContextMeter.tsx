'use client';

/**
 * ContextMeter (U60 / JM-U63e)
 *
 * Header chip with a CSS-only micro-ring. Estimate mode (Phase A — U65 gates
 * exact usage): numerator = the whole transcript's character count ÷ 4
 * (the standard token-estimate heuristic), denominator = the active model's
 * `context_window` from the registry. Always renders a leading `≈` and an
 * "estimated" tooltip in this mode so it never claims false precision.
 *
 * Thresholds: amber at 70%, red at 90%. A one-time banner appears the first
 * render that crosses 80% and offers "Start fresh session" (new session id;
 * old thread stays retrievable — the parent's `onStartFresh` does that). The
 * banner is suppressed again once usage drops back under 80% (e.g. after a
 * fresh session), so a later re-crossing fires it again — "exactly once per
 * crossing", never once per page load.
 */
import { useEffect, useRef, useState } from 'react';

interface ContextMeterProps {
  /** Total transcript character count this render represents. */
  charCount: number;
  /** Active model's context_window (tokens), or null while unknown. */
  contextWindow: number | null;
  onStartFresh: () => void;
}

const CHARS_PER_TOKEN = 4;
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function tierFor(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

const RING_COLOR: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'text-brand-500',
  warn: 'text-semantic-warning',
  danger: 'text-semantic-danger',
};

export default function ContextMeter({ charCount, contextWindow, onStartFresh }: ContextMeterProps) {
  const estimatedTokens = Math.ceil(charCount / CHARS_PER_TOKEN);
  const ratio = contextWindow && contextWindow > 0 ? Math.min(1, estimatedTokens / contextWindow) : 0;
  const tier = tierFor(ratio);
  const [bannerShown, setBannerShown] = useState(false);
  const wasAbove80 = useRef(false);

  useEffect(() => {
    const above80 = ratio >= 0.8;
    if (above80 && !wasAbove80.current) {
      setBannerShown(true);
    }
    if (!above80) {
      // Reset the crossing latch once usage drops back under 80% (e.g. a
      // fresh session) so a later re-crossing fires the banner again.
      wasAbove80.current = false;
      setBannerShown(false);
    } else {
      wasAbove80.current = true;
    }
  }, [ratio]);

  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
  const pct = Math.round(ratio * 100);

  return (
    <div className="relative">
      <div
        className="flex items-center gap-1.5 h-9 px-2.5 rounded-xl border border-bcc-border bg-bcc-white"
        title={
          contextWindow
            ? `≈${estimatedTokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens (estimated — characters ÷ ${CHARS_PER_TOKEN})`
            : 'Context usage — estimated'
        }
        data-testid="context-meter"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className={RING_COLOR[tier]} aria-hidden="true">
          <circle cx="10" cy="10" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className="text-caption font-mono text-bcc-text-secondary tabular-nums">≈{pct}%</span>
      </div>

      {bannerShown && (
        <div
          role="status"
          className="absolute right-0 top-full mt-2 z-20 w-72 rounded-xl border border-amber-200 bg-semantic-warningLight px-3 py-2.5 shadow-card"
          data-testid="context-meter-banner"
        >
          <p className="text-label text-amber-800">
            This conversation is using ≈{pct}% of the model&apos;s context window.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBannerShown(false);
                onStartFresh();
              }}
              className="h-9 px-3 rounded-xl bg-brand-600 text-white text-label font-medium hover:bg-brand-700"
            >
              Start fresh session
            </button>
            <button
              type="button"
              onClick={() => setBannerShown(false)}
              className="h-9 px-3 rounded-xl text-label text-amber-800 hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
