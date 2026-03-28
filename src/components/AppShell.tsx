'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  BarChart3,
  Building2,
  LayoutGrid,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
} from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/', icon: <Home className="w-5 h-5" /> },
  { label: 'CEO Board', href: '/ceo-board', icon: <BarChart3 className="w-5 h-5" /> },
  { label: 'Departments', href: '/workspace', icon: <Building2 className="w-5 h-5" /> },
  { label: 'Departments', href: '/ceo-board/departments', icon: <LayoutGrid className="w-5 h-5" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="w-5 h-5" /> },
];

function isActiveRoute(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const logoUrl = useLogoUrl();

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
          {NAV_ITEMS.map((item) => {
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
              {NAV_ITEMS.map((item) => {
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
          {NAV_ITEMS.map((item) => {
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
