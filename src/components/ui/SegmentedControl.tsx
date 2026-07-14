'use client';

/**
 * SegmentedControl (U60 / JM-U63a shared primitive)
 *
 * Two uses on the My AI CEO surface: the ThinkingSelector's Quick · Balanced ·
 * Deep · Max labels (desktop Control Strip) and the mobile
 * `Conversation | What's happening (n)` tab switch. A disabled segment still
 * renders (never removed) with its own tooltip, matching the "honest degraded
 * control" rule (spec (f)) — it just cannot be activated.
 */
interface Segment {
  id: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface SegmentedControlProps {
  segments: Segment[];
  value: string;
  onChange: (id: string) => void;
  'data-testid'?: string;
}

export default function SegmentedControl({ segments, value, onChange, 'data-testid': testId }: SegmentedControlProps) {
  return (
    <div
      role="tablist"
      data-testid={testId}
      className="inline-flex items-center rounded-xl border border-bcc-border bg-bcc-border-light p-0.5 gap-0.5"
    >
      {segments.map((seg) => {
        const active = seg.id === value;
        return (
          <button
            key={seg.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={seg.disabled}
            title={seg.title}
            onClick={() => !seg.disabled && onChange(seg.id)}
            className={`min-h-[36px] px-3 rounded-[10px] text-label font-medium transition-colors ${
              seg.disabled
                ? 'text-bcc-text-muted cursor-not-allowed'
                : active
                  ? 'bg-bcc-white text-bcc-text shadow-pill'
                  : 'text-bcc-text-secondary hover:text-bcc-text'
            }`}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
