'use client';

/**
 * PickerMenu (U60 / JM-U63a shared primitive)
 *
 * A desktop dropdown list anchored under its trigger — the AgentPicker /
 * ModelPicker on `lg`+. Renders LIST-ONLY (spec (f)): every row is already
 * pre-filtered by the caller (e.g. `isForbidden()` for models), this
 * component never re-derives its own item set. Closes on outside click and
 * Escape. On mobile the SAME item list is instead rendered inside a
 * `BottomSheet` by the caller — this component is desktop-only chrome.
 */
import { useEffect, useRef } from 'react';

export interface PickerMenuItem {
  id: string;
  label: string;
  sublabel?: string;
  badge?: string;
  disabled?: boolean;
}

interface PickerMenuProps {
  open: boolean;
  onClose: () => void;
  items: PickerMenuItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  emptyLabel?: string;
  'data-testid'?: string;
}

export default function PickerMenu({
  open,
  onClose,
  items,
  selectedId,
  onSelect,
  emptyLabel = 'Nothing to show.',
  'data-testid': testId,
}: PickerMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="listbox"
      data-testid={testId}
      className="absolute z-30 mt-1 w-64 max-h-80 overflow-y-auto rounded-xl border border-bcc-border bg-bcc-white shadow-card py-1"
    >
      {items.length === 0 && (
        <p className="px-3 py-2 text-caption text-bcc-text-muted">{emptyLabel}</p>
      )}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={item.id === selectedId}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            onSelect(item.id);
            onClose();
          }}
          className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 text-label min-h-[44px] ${
            item.disabled
              ? 'text-bcc-text-muted cursor-not-allowed'
              : item.id === selectedId
                ? 'bg-brand-50 text-brand-800'
                : 'text-bcc-text hover:bg-bcc-border-light'
          }`}
        >
          <span className="min-w-0">
            <span className="block truncate">{item.label}</span>
            {item.sublabel && <span className="block truncate text-caption text-bcc-text-muted">{item.sublabel}</span>}
          </span>
          {item.badge && (
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide rounded border border-brand-200 bg-brand-50 text-brand-700 px-1.5 py-0.5">
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
