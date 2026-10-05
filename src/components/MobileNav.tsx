'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Kanban, BarChart3, Building2, Terminal, Settings } from 'lucide-react';
import type { ComponentType } from 'react';

interface MobileNavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV_ITEMS: MobileNavItem[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/hq', label: 'Headquarters', icon: Building2 },
  { href: '/tasks/all', label: 'Tasks', icon: Kanban },
  { href: '/ceo-board', label: 'Board', icon: BarChart3 },
  { href: '/operator', label: 'Operator', icon: Terminal },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/**
 * Fixed bottom navigation for phones (md:hidden). The old AppShell sidebar
 * was retired by design (Track A1: "Top header + breadcrumbs handle
 * navigation"), but that left small screens with zero navigation affordance
 * — the header's own links/pills collide well before 768px. This is the
 * mobile-first replacement: top-level destinations, mounted once app-wide
 * from layout.tsx (see the pb-16 md:pb-0 companion padding there so this bar
 * never overlaps page content).
 *
 * A02 (@CC_NAV_ENTRY): the Headquarters entry (`/hq`, SPEC S1 navigation
 * "Headquarters") rides this live bar — the only app-wide nav surface layout
 * actually mounts. Six items at 375 px = 62.5 px each, above the S11 44 px
 * control floor; the bar scrolls horizontally rather than squeezing labels.
 */
export default function MobileNav() {
  const pathname = usePathname();

  // The interview/onboarding flows are a gated, self-contained shell with
  // their own chrome — they are not part of the day-to-day dashboard nav.
  if (pathname.startsWith('/interview') || pathname.startsWith('/onboarding')) {
    return null;
  }

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 md:hidden flex items-stretch gap-0 overflow-x-auto bg-white border-t border-gray-200"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {NAV_ITEMS.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex-1 min-w-[62px] flex flex-col items-center justify-center gap-0.5 py-2 min-h-[48px] text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300 ${
              active ? 'text-brand-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
