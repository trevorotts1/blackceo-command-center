'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  MessageSquare,
  FolderOpen,
  Wand2,
  NotebookText,
  Target,
  BookOpen,
  Brain,
  Search,
  Phone,
  Globe,
  ArrowLeft,
} from 'lucide-react';
import type { ReactNode } from 'react';

interface OperatorNavItem {
  href: string;
  label: string;
  icon: ReactNode;
  accent: string;
  /** When true the tile/route is a Wave 1 placeholder (route not yet implemented). */
  placeholder?: boolean;
}

export const OPERATOR_NAV: OperatorNavItem[] = [
  { href: '/operator', label: 'Console', icon: <Home size={16} />, accent: '#43A047' },
  { href: '/operator/bridge', label: 'Bridge', icon: <MessageSquare size={16} />, accent: '#3B82F6' },
  { href: '/operator/workspace', label: 'Workspace', icon: <FolderOpen size={16} />, accent: '#8B5CF6' },
  { href: '/operator/studio', label: 'Studio', icon: <Wand2 size={16} />, accent: '#EC4899' },
  { href: '/operator/notebook', label: 'Notebook', icon: <NotebookText size={16} />, accent: '#F59E0B' },
  { href: '/operator/goals', label: 'Goals', icon: <Target size={16} />, accent: '#FBBF24' },
  { href: '/operator/journal', label: 'Journal', icon: <BookOpen size={16} />, accent: '#A3E635' },
  { href: '/operator/memory', label: 'Memory', icon: <Brain size={16} />, accent: '#22D3EE' },
  { href: '/operator/research', label: 'Research', icon: <Search size={16} />, accent: '#06B6D4' },
  { href: '/operator/call', label: 'Call Mode', icon: <Phone size={16} />, accent: '#10B981', placeholder: true },
  { href: '/operator/web-agent', label: 'Web Agent', icon: <Globe size={16} />, accent: '#6366F1', placeholder: true },
];

export default function OperatorSidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="hidden md:flex flex-col w-[244px] shrink-0 border-r border-bcc-border bg-bcc-white"
      aria-label="Operator Console navigation"
    >
      <div className="px-5 pt-6 pb-5 border-b border-bcc-border-light">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-bcc-text-secondary hover:text-bcc-text transition-colors"
        >
          <ArrowLeft size={12} />
          Command Center
        </Link>
        <div className="mt-2 text-xl font-bold tracking-tight text-bcc-text">
          Operator Console
        </div>
        <div className="mt-1 text-[12px] text-bcc-text-muted">
          Direct line to your CLIs and vault.
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-4">
        <div className="px-5 pb-2 text-[10px] uppercase tracking-[0.2em] text-bcc-text-muted font-semibold">
          Sub-modules
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {OPERATOR_NAV.map((item) => {
            const active =
              item.href === '/operator'
                ? pathname === '/operator'
                : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`group relative flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
                    active
                      ? 'bg-bcc-primary-light text-bcc-text'
                      : 'text-bcc-text-secondary hover:bg-bcc-border-light hover:text-bcc-text'
                  }`}
                >
                  {active && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r"
                      style={{ background: item.accent }}
                    />
                  )}
                  <span
                    className="grid place-items-center w-6 h-6 rounded-md"
                    style={{
                      color: active ? item.accent : undefined,
                    }}
                  >
                    {item.icon}
                  </span>
                  <span className="text-[14px] font-medium flex-1">{item.label}</span>
                  {item.placeholder && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-bcc-border-light text-bcc-text-muted">
                      Soon
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-5 py-4 border-t border-bcc-border-light text-[11px] text-bcc-text-muted">
        Press <kbd className="px-1.5 py-0.5 rounded border border-bcc-border bg-bcc-bg font-mono text-[10px]">Cmd K</kbd> for the command palette.
      </div>
    </aside>
  );
}
