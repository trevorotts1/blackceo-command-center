'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Clock, MessagesSquare, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMissionControl } from '@/lib/store';
import type { Event } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

type FeedFilter = 'all' | 'tasks' | 'agents';

// localStorage preference keys (mirrors AppShell's `bcc-`-style convention,
// using the `cc.livefeed.*` namespace requested for this feature).
const LS_OPEN_KEY = 'cc.livefeed.open';
const LS_WIDTH_KEY = 'cc.livefeed.width';

// Resize clamps. Min keeps the feed readable; max is applied as a fraction of
// the viewport at drag time so the Kanban board can never be crushed.
const MIN_WIDTH = 300;
const DEFAULT_WIDTH = 320; // matches the legacy w-80 (20rem) feel
const MAX_WIDTH_FRACTION = 0.4; // never exceed 40% of the viewport

// Below this viewport width the open rail renders as an overlay drawer (with a
// scrim) instead of a push-panel, so it never squeezes the board on mobile.
const MOBILE_BREAKPOINT = 1024; // matches Tailwind `lg`

export function LiveFeed() {
  const { events } = useMissionControl();
  const [filter, setFilter] = useState<FeedFilter>('all');

  // Default = HIDDEN so the Kanban board uses the full width. The user's
  // choice is restored from localStorage on mount (SSR-safe: only touched
  // inside effects, never during render).
  const [isOpen, setIsOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isMobile, setIsMobile] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const asideRef = useRef<HTMLElement | null>(null);

  // ----- Restore persisted prefs on mount -----
  useEffect(() => {
    const savedOpen = localStorage.getItem(LS_OPEN_KEY);
    if (savedOpen === 'true') setIsOpen(true);

    const savedWidth = Number(localStorage.getItem(LS_WIDTH_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= MIN_WIDTH) {
      setWidth(savedWidth);
    }
    setHydrated(true);
  }, []);

  // ----- Track viewport for overlay-vs-push behavior -----
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Clamp the persisted width to the current viewport (covers shrinking the
  // window after a wide-screen drag) once we know the viewport.
  useEffect(() => {
    if (!hydrated || isMobile) return;
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_FRACTION));
    setWidth((w) => Math.min(Math.max(w, MIN_WIDTH), max));
  }, [hydrated, isMobile]);

  const open = useCallback(() => {
    setIsOpen(true);
    localStorage.setItem(LS_OPEN_KEY, 'true');
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    localStorage.setItem(LS_OPEN_KEY, 'false');
  }, []);

  // ----- Drag-to-resize (pointer + touch via Pointer Events) -----
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (isMobile) return; // no drag-resize in overlay mode
      e.preventDefault();
      setIsDragging(true);

      const startX = e.clientX;
      const startWidth = width;
      const maxWidth = Math.max(
        MIN_WIDTH,
        Math.floor(window.innerWidth * MAX_WIDTH_FRACTION)
      );

      const onMove = (ev: PointerEvent) => {
        // Rail is on the right edge: dragging the splitter LEFT widens it.
        const delta = startX - ev.clientX;
        const next = Math.min(Math.max(startWidth + delta, MIN_WIDTH), maxWidth);
        setWidth(next);
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        setIsDragging(false);
        const delta = startX - ev.clientX;
        const finalW = Math.min(Math.max(startWidth + delta, MIN_WIDTH), maxWidth);
        localStorage.setItem(LS_WIDTH_KEY, String(Math.round(finalW)));
      };

      // Avoid text selection / I-beam cursor flicker while dragging.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [isMobile, width]
  );

  // Keyboard resize on the splitter (a11y): arrow keys nudge width.
  const onSplitterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isMobile) return;
      const maxWidth = Math.max(
        MIN_WIDTH,
        Math.floor(window.innerWidth * MAX_WIDTH_FRACTION)
      );
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = Math.min(width + 24, maxWidth);
      if (e.key === 'ArrowRight') next = Math.max(width - 24, MIN_WIDTH);
      if (next !== null) {
        e.preventDefault();
        setWidth(next);
        localStorage.setItem(LS_WIDTH_KEY, String(Math.round(next)));
      }
    },
    [isMobile, width]
  );

  const filteredEvents = events.filter((event) => {
    if (filter === 'all') return true;
    if (filter === 'tasks')
      return ['task_created', 'task_assigned', 'task_status_changed', 'task_completed'].includes(
        event.type
      );
    if (filter === 'agents')
      return ['agent_joined', 'agent_status_changed', 'message_sent'].includes(event.type);
    return true;
  });

  // ===== Floating "Show Live Feed" pill (rendered when collapsed) =====
  const showPill = (
    <button
      type="button"
      onClick={open}
      aria-label="Show Live Feed"
      aria-expanded={false}
      className="fixed top-[4.5rem] right-3 z-30 flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 shadow-md transition-all hover:shadow-lg hover:border-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 min-h-[44px]"
    >
      <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-500" />
      </span>
      <MessagesSquare className="h-4 w-4 text-brand-600" aria-hidden="true" />
      <span>Live Feed</span>
    </button>
  );

  // ===== The rail contents (header + tabs + events) — unchanged behavior =====
  const railBody = (
    <>
      {/* Header */}
      <div className="p-3 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
            </span>
            <span className="text-sm font-semibold text-gray-900">Live Feed</span>
          </div>
          <button
            type="button"
            onClick={close}
            className="flex h-9 w-9 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Hide Live Feed"
            aria-expanded={true}
          >
            {isMobile ? <X className="h-5 w-5" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1 mt-3">
          {(['all', 'tasks', 'agents'] as FeedFilter[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                filter === tab
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              {tab.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Events List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredEvents.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm" role="status">
            No events yet
          </div>
        ) : (
          filteredEvents.map((event) => <EventItem key={event.id} event={event} />)
        )}
      </div>
    </>
  );

  // Avoid a flash of the wrong state before localStorage is read.
  if (!hydrated) return null;

  // ----- Collapsed: just the floating pill, board keeps full width -----
  if (!isOpen) return showPill;

  // ----- Open + mobile: overlay drawer with scrim -----
  if (isMobile) {
    return (
      <AnimatePresence>
        <motion.div
          key="livefeed-overlay"
          className="fixed inset-0 z-40 lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Scrim */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={close}
            aria-hidden="true"
          />
          {/* Drawer */}
          <motion.aside
            ref={asideRef as React.RefObject<HTMLElement>}
            role="complementary"
            aria-label="Live Feed"
            className="absolute right-0 top-0 bottom-0 flex w-[88vw] max-w-sm flex-col bg-white shadow-xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
          >
            {railBody}
          </motion.aside>
        </motion.div>
      </AnimatePresence>
    );
  }

  // ----- Open + desktop: push-panel with draggable splitter -----
  return (
    <aside
      ref={asideRef as React.RefObject<HTMLElement>}
      role="complementary"
      aria-label="Live Feed"
      style={{ width }}
      className={`relative hidden flex-shrink-0 flex-col border-l border-gray-200 bg-white lg:flex ${
        isDragging ? '' : 'transition-[width] duration-200 ease-in-out'
      }`}
    >
      {/* Draggable splitter on the left edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Live Feed"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onSplitterKeyDown}
        className="group absolute left-0 top-0 z-10 flex h-full w-2 -translate-x-1/2 cursor-col-resize items-center justify-center focus:outline-none"
      >
        <span
          className={`h-full w-0.5 transition-colors ${
            isDragging ? 'bg-brand-500' : 'bg-transparent group-hover:bg-brand-300 group-focus-visible:bg-brand-500'
          }`}
        />
      </div>
      {railBody}
    </aside>
  );
}

function EventItem({ event }: { event: Event }) {
  const getEventDot = (type: string) => {
    switch (type) {
      case 'task_created':
        return 'bg-blue-500';
      case 'task_assigned':
        return 'bg-brand-500';
      case 'task_status_changed':
        return 'bg-amber-500';
      case 'task_completed':
        return 'bg-emerald-500';
      case 'message_sent':
        return 'bg-brand-500';
      case 'agent_joined':
        return 'bg-cyan-500';
      case 'agent_status_changed':
        return 'bg-orange-500';
      case 'system':
        return 'bg-gray-500';
      default:
        return 'bg-gray-400';
    }
  };

  const isHighlight = event.type === 'task_created' || event.type === 'task_completed';

  return (
    <div
      className={`p-2.5 rounded-lg animate-slide-in transition-colors ${
        isHighlight
          ? 'bg-brand-50 border border-brand-100'
          : 'hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${getEventDot(event.type)}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 leading-snug">
            {event.message}
          </p>
          <div className="flex items-center gap-1 mt-1 text-sm text-gray-400">
            <Clock className="w-3 h-3" />
            {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>
    </div>
  );
}
