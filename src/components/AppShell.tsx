'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  BarChart3,
  Building2,
  LayoutGrid,
  Mic,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
} from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { parseWorkspaceSlugs, type WorkspacesStatus } from '@/lib/dashboard-workspaces';
import { insertEngineNavItem, shouldShowEngineNavItem } from '@/lib/nav-gating';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/', icon: <Home className="w-5 h-5" /> },
  { label: 'CEO Board', href: '/ceo-board', icon: <BarChart3 className="w-5 h-5" /> },
  { label: 'Department Boards', href: '/workspace', icon: <Building2 className="w-5 h-5" /> },
  { label: 'Department Scores', href: '/ceo-board/departments', icon: <LayoutGrid className="w-5 h-5" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="w-5 h-5" /> },
];

// GK-15 / U77: the Podcast entry rides the shared /api/workspaces engine-
// presence signal (Option C, "engine-gated nav" — renders ONLY where the
// Podcast Production Engine's workspace is seeded on this box). Placed after
// the first "Departments" entry (href=/workspace) per the payload's own
// WIRING.md placement note. See src/lib/nav-gating.ts for the pure
// insertion/gating logic (unit-tested independently of this component).
const PODCAST_NAV_ITEM: NavItem = {
  label: 'Podcast',
  href: '/podcast',
  icon: <Mic className="w-5 h-5" />,
};
const PODCAST_NAV_ANCHOR_HREF = '/workspace';
const PODCAST_WORKSPACE_SLUG = 'podcast';

function isActiveRoute(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const logoUrl = useLogoUrl();

  // GK-15 / U77: same-origin, unauthenticated /api/workspaces read (no bearer
  // needed from the browser) — mirrors src/app/page.tsx's producer-board
  // gating fetch. 'loading'/'error' both fail CLOSED (no Podcast nav item)
  // per shouldShowEngineNavItem's contract; a transient failure here simply
  // means the nav item stays hidden until the next successful read, never a
  // dead link on a box without the engine.
  const [presentSlugs, setPresentSlugs] = useState<Set<string>>(new Set());
  const [workspacesStatus, setWorkspacesStatus] = useState<WorkspacesStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setPresentSlugs(parseWorkspaceSlugs(data));
        setWorkspacesStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setWorkspacesStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const navItems = useMemo(() => {
    const showPodcast = shouldShowEngineNavItem(workspacesStatus, presentSlugs, PODCAST_WORKSPACE_SLUG);
    return insertEngineNavItem(NAV_ITEMS, PODCAST_NAV_ANCHOR_HREF, PODCAST_NAV_ITEM, showPodcast);
  }, [workspacesStatus, presentSlugs]);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Load collapsed preference from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('bcc-sidebar-collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('bcc-sidebar-collapsed', String(next));
  };

  return (
    <div className="flex min-h-screen">
      {/* ===== DESKTOP SIDEBAR ===== */}
      <aside
        className={`hidden md:flex flex-col bg-white border-r border-gray-200 transition-[width] duration-200 ease-in-out flex-shrink-0 ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        {/* Logo area */}
        <div className="h-14 flex items-center px-4 border-b border-gray-100">
          <Link href="/" className="flex items-center gap-2 overflow-hidden">
            <img src={logoUrl} alt="Logo" className="h-8 w-8 flex-shrink-0" />
            {!collapsed && (
              <span className="text-sm font-bold text-gray-900 whitespace-nowrap">
                Command Center
              </span>
            )}
          </Link>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-3 px-2 space-y-1">
          {navItems.map((item) => {
            const active = isActiveRoute(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-50 text-brand-700 border-l-[3px] border-brand-500'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border-l-[3px] border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
              >
                <span className={active ? 'text-brand-600' : 'text-gray-400'}>
                  {item.icon}
                </span>
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-gray-100">
          <button
            onClick={toggleCollapsed}
            className="flex items-center justify-center w-full px-3 py-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* ===== MAIN CONTENT ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 flex-shrink-0">
          <Link href="/" className="flex items-center gap-2">
            <img src={logoUrl} alt="Logo" className="h-8 w-8" />
            <span className="text-sm font-bold text-gray-900">Command Center</span>
          </Link>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </header>

        {/* Mobile slide-out overlay */}
        {mobileOpen && (
          <div className="md:hidden fixed inset-0 z-50">
            <div
              className="absolute inset-0 bg-black/30"
              onClick={() => setMobileOpen(false)}
            />
            <nav className="absolute top-14 left-0 right-0 bg-white border-b border-gray-200 shadow-lg p-3 space-y-1">
              {navItems.map((item) => {
                const active = isActiveRoute(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <span className={active ? 'text-brand-600' : 'text-gray-400'}>
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex items-center justify-around py-2 px-1 z-40 safe-area-bottom">
          {navItems.map((item) => {
            const active = isActiveRoute(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors min-w-[56px] ${
                  active ? 'text-brand-600' : 'text-gray-400'
                }`}
              >
                <span className={active ? 'text-brand-600' : 'text-gray-400'}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
