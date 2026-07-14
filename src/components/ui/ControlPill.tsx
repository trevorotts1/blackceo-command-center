'use client';

/**
 * ControlPill (U60 / JM-U63a shared primitive)
 *
 * The small rounded control used across the My AI CEO Control Strip
 * (AgentPicker / ModelPicker / ThinkingSelector triggers, the Delegate
 * button). Every visual value resolves to a `tailwind.config.ts` token —
 * `shadow-pill`, `bcc-*` surfaces/borders, `rounded-xl` — never a bespoke
 * color or shadow. A `disabled` pill still renders its `title` tooltip so a
 * degraded control (spec (f): "Model is set box-wide for now") stays honest
 * instead of disappearing.
 */
import type { ComponentType, ReactNode } from 'react';

interface ControlPillProps {
  icon?: ComponentType<{ className?: string }>;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  'data-testid'?: string;
}

export default function ControlPill({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
  active,
  'data-testid': testId,
}: ControlPillProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      aria-disabled={disabled}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border text-label font-medium transition-colors shrink-0 ${
        disabled
          ? 'bg-bcc-border-light border-bcc-border text-bcc-text-muted cursor-not-allowed'
          : active
            ? 'bg-brand-50 border-brand-300 text-brand-800 hover:bg-brand-100'
            : 'bg-bcc-white border-bcc-border text-bcc-text hover:border-brand-300 hover:shadow-pill'
      }`}
    >
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="truncate max-w-[9rem]">{label}</span>
    </button>
  );
}
