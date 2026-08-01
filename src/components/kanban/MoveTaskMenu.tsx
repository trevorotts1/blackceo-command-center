'use client';

/**
 * Touch-friendly "Move to..." affordance for task cards.
 *
 * Native HTML5 drag-and-drop (used by the desktop board in MissionQueue) does
 * not fire on touch devices, so there was previously NO way to change a
 * task's column on a phone/tablet. This renders a small icon button (real
 * <button>) that opens a menu of the board's columns (real <button role=
 * "menuitem">s) — fully keyboard-navigable without a drag-and-drop library.
 * Selecting a column calls the same onSelect handler MissionQueue wires to
 * its shared status-change path (including the Blocked confirmation modal).
 */

import { useEffect, useRef, useState } from 'react';
import { Move } from 'lucide-react';

interface MoveTaskMenuColumn {
  id: string;
  label: string;
  maxWip?: number;
}

interface MoveTaskMenuProps {
  columns: MoveTaskMenuColumn[];
  currentColumnId: string;
  onSelect: (columnId: string) => void;
  taskTitle: string;
  /** Current task count per column id, for WIP limit enforcement. */
  columnTaskCounts?: Record<string, number>;
}

function isMoveTargetAtCapacity(col: MoveTaskMenuColumn, columnTaskCounts?: Record<string, number>): boolean {
  if (typeof col.maxWip !== 'number' || !columnTaskCounts) return false;
  const count = columnTaskCounts[col.id] ?? 0;
  return count >= col.maxWip;
}

export function MoveTaskMenu({ columns, currentColumnId, onSelect, taskTitle, columnTaskCounts }: MoveTaskMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    // Stop propagation so tapping the button/menu never bubbles up to the
    // card's onClick (which opens the edit modal).
    <div ref={containerRef} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Move task: ${taskTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors"
      >
        <Move className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Move task to column"
          className="absolute right-0 top-full mt-1 z-20 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1"
        >
          {columns.map((col) => {
            const isCurrent = col.id === currentColumnId;
            const atCapacity = isMoveTargetAtCapacity(col, columnTaskCounts);
            const disabled = isCurrent || atCapacity;
            return (
              <button
                key={col.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  onSelect(col.id);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  isCurrent ? 'text-gray-300 cursor-not-allowed' : atCapacity ? 'text-gray-300 cursor-not-allowed line-through' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {col.label}
                {isCurrent && <span className="text-gray-300"> (current)</span>}
                {atCapacity && !isCurrent && <span className="text-red-400"> (at capacity)</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
