'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Search } from 'lucide-react';
import { Command } from 'cmdk';
import { OPERATOR_NAV } from './OperatorSidebar';

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  href: string;
  placeholder?: boolean;
}

/**
 * App-wide top-level destinations. Cmd+K used to only surface the 11
 * operator sub-routes (built from OPERATOR_NAV below) — everything else in
 * the app (Home, Tasks, the CEO board, Personas, SOPs, Settings...) had no
 * keyboard-driven way to jump to it. This group is the fix; it's rendered
 * ahead of the operator group so the most common destinations sort first.
 */
const TOP_LEVEL_NAV: PaletteAction[] = [
  { id: 'topnav:/', label: 'Home', hint: '/', href: '/' },
  { id: 'topnav:/tasks/all', label: 'All Tasks', hint: '/tasks/all', href: '/tasks/all' },
  { id: 'topnav:/tasks/by-department', label: 'Departments', hint: '/tasks/by-department', href: '/tasks/by-department' },
  { id: 'topnav:/ceo-board', label: 'Performance Board', hint: '/ceo-board', href: '/ceo-board' },
  { id: 'topnav:/conversational-ai', label: 'Conversational AI', hint: '/conversational-ai', href: '/conversational-ai' },
  { id: 'topnav:/personas', label: 'Personas', hint: '/personas', href: '/personas' },
  // NB: /sops has no page.tsx of its own (only /sops/proposals does) — routing
  // here would just recreate the /agent-roster 404 this pass exists to fix.
  { id: 'topnav:/sops/proposals', label: 'SOP Library', hint: '/sops/proposals', href: '/sops/proposals' },
  { id: 'topnav:/settings/intelligence', label: 'Intelligence Settings', hint: '/settings/intelligence', href: '/settings/intelligence' },
  { id: 'topnav:/settings/company', label: 'Company Settings', hint: '/settings/company', href: '/settings/company' },
  { id: 'topnav:/settings', label: 'Settings', hint: '/settings', href: '/settings' },
];

function buildOperatorActions(): PaletteAction[] {
  return OPERATOR_NAV.map((item) => ({
    id: `nav:${item.href}`,
    label: `Open ${item.label}`,
    hint: item.placeholder ? 'placeholder (ships Wave 1)' : item.href,
    href: item.href,
    placeholder: item.placeholder,
  }));
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const operatorActions = useMemo(buildOperatorActions, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function execute(action: PaletteAction) {
    setOpen(false);
    router.push(action.href);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 grid place-items-start pt-[14vh] bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ y: -12, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[min(640px,92vw)] mx-auto rounded-xl border border-bcc-border bg-bcc-white shadow-xl overflow-hidden"
          >
            <Command label="Operator command palette" loop>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-bcc-border-light">
                <Search size={16} className="text-bcc-text-muted" />
                <Command.Input
                  autoFocus
                  placeholder="Jump to a sub-module..."
                  className="flex-1 bg-transparent outline-none text-[14px] text-bcc-text placeholder:text-bcc-text-muted"
                />
                <kbd className="px-1.5 py-0.5 rounded border border-bcc-border bg-bcc-bg font-mono text-[10px] text-bcc-text-muted">
                  Esc
                </kbd>
              </div>
              <div className="p-2 max-h-[50vh] overflow-y-auto">
                <Command.Empty className="px-4 py-6 text-center text-sm text-bcc-text-muted">
                  No matches.
                </Command.Empty>
                <Command.Group
                  heading="Navigate"
                  className="text-[10px] uppercase tracking-[0.18em] text-bcc-text-muted px-3 py-2"
                >
                  {TOP_LEVEL_NAV.map((action) => (
                    <Command.Item
                      key={action.id}
                      value={`${action.label} ${action.hint}`}
                      onSelect={() => execute(action)}
                      className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-bcc-text aria-selected:bg-bcc-primary-light"
                    >
                      <span className="flex-1 text-[14px]">{action.label}</span>
                      <span className="text-[11px] text-bcc-text-muted">{action.hint}</span>
                      <ChevronRight size={12} className="text-bcc-text-muted" />
                    </Command.Item>
                  ))}
                </Command.Group>
                <Command.Group
                  heading="Operator Console"
                  className="text-[10px] uppercase tracking-[0.18em] text-bcc-text-muted px-3 py-2"
                >
                  {operatorActions.map((action) => (
                    <Command.Item
                      key={action.id}
                      value={`${action.label} ${action.hint}`}
                      onSelect={() => execute(action)}
                      className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-bcc-text aria-selected:bg-bcc-primary-light"
                    >
                      <span className="flex-1 text-[14px]">{action.label}</span>
                      <span className="text-[11px] text-bcc-text-muted">{action.hint}</span>
                      <ChevronRight size={12} className="text-bcc-text-muted" />
                    </Command.Item>
                  ))}
                </Command.Group>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
