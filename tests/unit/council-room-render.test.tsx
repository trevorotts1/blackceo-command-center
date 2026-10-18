/**
 * CWE-032 - council room, seats, and reading view: REAL render tests.
 *
 * Renders the actual CouncilShell / CouncilRoom / CouncilReadingView /
 * AdvisorCardDrawer components (react-dom via @testing-library/react +
 * jsdom, see vitest.component.config.ts) against the labeled synthetic
 * fixtures in src/components/council/council-room-fixtures.ts. Fixture
 * provenance: invented by CWE-032 for component tests; the room carries
 * mode 'sample' and renders the persistent "Fictional sample" badge.
 *
 * Acceptance covered (Directive Sections 21, 22, 23; CWE-032 brief):
 * - All nine seats render in locked roster slot order even though the
 *   fixture delivers them in scrambled arrival order.
 * - Full names render unclipped for the longest names: Tiffany Aliche,
 *   Michelle Obama, Dr. Dennis Kimbro, Brené Brown (accent preserved).
 * - Every seat is a keyboard-focusable button whose accessible name
 *   carries advisor, responsibility, and current state; the reading-view
 *   toggle is keyboard operable; Enter opens the drawer, Escape closes
 *   it, and focus is restored to the seat that opened it.
 * - Honest state labels: a queued seat reads "Waiting in queue" and the
 *   word "thinking" appears nowhere in the rendered room.
 * - Reduced motion: with prefers-reduced-motion matched, the shell sets
 *   data-reduced-motion and every seat's information is still present.
 * - Sample honesty (T101): the "Fictional sample" badge is rendered.
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CouncilShell } from '../../src/components/council/CouncilShell';
import { AdvisorSeat } from '../../src/components/council/AdvisorSeat';
import {
  SAMPLE_ROOM_VIEW,
  QUEUED_ROOM_VIEW,
  fixtureMedallionSrcs,
} from '../../src/components/council/council-room-fixtures';

const { small, large } = fixtureMedallionSrcs('/portraits');

const ROSTER_NAMES = [
  'Simon Sinek',
  'T. D. Jakes',
  'Oprah Winfrey',
  'Tiffany Aliche',
  'Russell Brunson',
  'Michelle Obama',
  'Brené Brown',
  'Dr. Dennis Kimbro',
  'Les Brown',
];

function renderShell(room = SAMPLE_ROOM_VIEW, initialView: 'room' | 'reading' = 'room') {
  return render(
    <CouncilShell
      room={room}
      medallionSrcBySeat={small}
      medallionLargeSrcBySeat={large}
      initialView={initialView}
    />,
  );
}

beforeEach(() => {
  // jsdom has no matchMedia by default; default to "no preference".
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
});

describe('room rendering and stable slot order', () => {
  it('renders all nine seats in roster order despite scrambled arrival', () => {
    renderShell();
    const seats = screen.getAllByTestId(/^council-seat-/);
    expect(seats).toHaveLength(9);
    const domSeatIds = seats.map((el) => el.getAttribute('data-seat-id'));
    expect(domSeatIds).toEqual([
      'simon-sinek',
      'td-jakes',
      'oprah-winfrey',
      'tiffany-aliche',
      'russell-brunson',
      'michelle-obama',
      'brene-brown',
      'dennis-kimbro',
      'les-brown',
    ]);
    // The visible names follow the same order.
    const names = seats.map(
      (el) => el.querySelector('.council-seat-name')?.textContent,
    );
    expect(names).toEqual(ROSTER_NAMES);
  });

  it('renders the longest full names unclipped, accents preserved', () => {
    renderShell();
    for (const name of ['Tiffany Aliche', 'Michelle Obama', 'Dr. Dennis Kimbro', 'Brené Brown']) {
      const el = screen.getByText(name, { selector: '.council-seat-name' });
      expect(el.textContent).toBe(name);
      // Name is rendered as text in the seat, never replaced by initials.
      expect(el.closest('button')?.textContent).toContain(name);
    }
  });

  it('shows the persistent fictional sample badge (T101)', () => {
    renderShell();
    expect(screen.getByTestId('council-shell-mode-badge').textContent).toBe('Fictional sample');
    expect(screen.getByTestId('council-mode-badge').textContent).toBe('Fictional sample');
  });

  it('shows the quiet center: decision, phase, and crux', () => {
    renderShell();
    const room = screen.getByTestId('council-room');
    expect(room.textContent).toContain('Pilot the revised coaching offer with new clients next month?');
    expect(room.textContent).toContain('Round 2 of 3: Challenge');
    expect(room.textContent).toContain('demand evidence versus delivery capacity');
    expect(room.textContent).toContain('6 of 9 perspectives are in');
  });

  it('marks the current round in the stepper with text, not color alone', () => {
    renderShell();
    const stepper = screen.getByTestId('council-round-stepper');
    const current = stepper.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Round 2: Challenge');
    expect(current?.textContent).toContain('(current)');
  });
});

describe('seat controls and honest states', () => {
  it('every seat is a button with name, responsibility, and state in its accessible name', () => {
    renderShell();
    for (const seat of SAMPLE_ROOM_VIEW.seats) {
      const el = screen.getByTestId(`council-seat-${seat.seatId}`);
      expect(el.tagName).toBe('BUTTON');
      const label = el.getAttribute('aria-label') ?? '';
      expect(label).toContain('current state:');
    }
    const tiffany = screen.getByTestId('council-seat-tiffany-aliche');
    expect(tiffany.getAttribute('aria-label')).toBe(
      'Tiffany Aliche, financial stability and sustainable commitments, current state: Opposes',
    );
    const kimbro = screen.getByTestId('council-seat-dennis-kimbro');
    expect(kimbro.getAttribute('aria-label')).toContain('Waiting in queue');
  });

  it('a queued seat never renders as thinking, anywhere in the room', () => {
    renderShell(QUEUED_ROOM_VIEW);
    const shell = screen.getByTestId('council-shell');
    expect(shell.textContent).not.toMatch(/thinking/i);
    for (const name of ROSTER_NAMES) {
      expect(shell.textContent).toContain(name);
    }
    const waiting = screen.getAllByText('Waiting in queue');
    expect(waiting.length).toBe(9);
  });

  it('a completed seat shows its stance from the card; the full seat shows role and preferred option', () => {
    renderShell();
    const tiffany = screen.getByTestId('council-seat-tiffany-aliche');
    expect(tiffany.textContent).toContain('Opposes');
    // The room uses the compact stage density (locked reference): the
    // preferred option is one tap away in the drawer, asserted below in
    // the drawer tests and here on the full-density seat variant.
    const tiffanySeat = SAMPLE_ROOM_VIEW.seats.find((s) => s.seatId === 'tiffany-aliche')!;
    cleanup();
    render(<AdvisorSeat seat={tiffanySeat} medallionSrc={small['tiffany-aliche']} />);
    const full = screen.getByTestId('council-seat-tiffany-aliche');
    expect(full.textContent).toContain('financial stability and sustainable commitments');
    expect(full.textContent).toContain('Prefers: B. Pilot the revised offer with new clients');
  });

  it('a started seat shows no stance: nothing has been committed', () => {
    renderShell();
    const michelle = screen.getByTestId('council-seat-michelle-obama');
    expect(michelle.textContent).toContain('In progress');
    expect(michelle.textContent).not.toContain('Supports');
  });
});

describe('keyboard operability and the drawer', () => {
  it('every seat and the view toggle are reachable and operable by keyboard', async () => {
    const user = userEvent.setup();
    renderShell();
    const toggle = screen.getByTestId('council-view-reading');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('council-reading-view')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    // Back to the room, then tab onto the first seat and open it.
    screen.getByTestId('council-view-room').focus();
    await user.keyboard('{Enter}');
    const firstSeat = screen.getByTestId('council-seat-simon-sinek');
    firstSeat.focus();
    expect(document.activeElement).toBe(firstSeat);
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText('Simon Sinek', { selector: 'h2' })).toBeTruthy();
    // Focus moved into the drawer (to its Close control).
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape closes and focus returns to the seat that opened it.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(firstSeat);
  });

  it('the drawer tells the truth for a seat with no committed card', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByTestId('council-seat-dennis-kimbro'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Dr. Dennis Kimbro');
    expect(dialog.textContent).toContain('Waiting in queue');
    expect(dialog.textContent).toContain('waiting in the queue; nothing has started');
    expect(dialog.textContent).toContain(
      'AI perspective inspired by the published work of Dr. Dennis Kimbro. Not the individual and not an endorsement.',
    );
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the drawer shows the committed card fields for a completed seat', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByTestId('council-seat-tiffany-aliche'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Delivery capacity is unproven at twice the volume');
    expect(dialog.textContent).toContain('Confirm the cash reserve covers the full pilot cost');
    expect(dialog.textContent).toContain('prefers: B. Pilot the revised offer with new clients');
    expect(dialog.textContent).toContain('Evidence strength');
  });
});

describe('reading view equivalence', () => {
  it('exposes every seat and its committed summary without the spatial room', () => {
    renderShell(SAMPLE_ROOM_VIEW, 'reading');
    expect(screen.queryByTestId('council-room')).toBeNull();
    const rows = screen.getAllByTestId(/^council-reading-row-/);
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.getAttribute('data-seat-id'))).toEqual([
      'simon-sinek',
      'td-jakes',
      'oprah-winfrey',
      'tiffany-aliche',
      'russell-brunson',
      'michelle-obama',
      'brene-brown',
      'dennis-kimbro',
      'les-brown',
    ]);
    const tiffanyRow = screen.getByTestId('council-reading-row-tiffany-aliche');
    expect(tiffanyRow.textContent).toContain('Opposes');
    expect(tiffanyRow.textContent).toContain('Strongest objection: Delivery capacity is unproven');
    const kimbroRow = screen.getByTestId('council-reading-row-dennis-kimbro');
    expect(kimbroRow.textContent).toContain('Waiting in the queue');
    expect(kimbroRow.getAttribute('aria-label')).toContain('Dr. Dennis Kimbro');
  });

  it('reading rows open the same drawer', async () => {
    const user = userEvent.setup();
    renderShell(SAMPLE_ROOM_VIEW, 'reading');
    await user.click(screen.getByTestId('council-reading-row-brene-brown'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Brené Brown');
    expect(dialog.textContent).toContain('Conditional');
  });
});

describe('reduced motion', () => {
  it('mirrors the preference onto the shell and keeps all information', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderShell();
    const shell = screen.getByTestId('council-shell');
    expect(shell.getAttribute('data-reduced-motion')).toBe('true');
    // No information is removed: all nine seats still render fully.
    expect(screen.getAllByTestId(/^council-seat-/)).toHaveLength(9);
    expect(shell.textContent).toContain('Brené Brown');
    expect(shell.textContent).toContain('Waiting in queue');
  });

  it('defaults to no reduced-motion flag without the preference', () => {
    renderShell();
    expect(screen.getByTestId('council-shell').getAttribute('data-reduced-motion')).toBe('false');
  });
});

describe('fireEvent smoke (drawer close button restores focus)', () => {
  it('clicking a seat then Close returns focus to that seat', () => {
    renderShell();
    const seat = screen.getByTestId('council-seat-les-brown');
    seat.focus();
    fireEvent.click(seat);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(seat);
  });
});

describe('live advisor selection continuity (WER-018)', () => {
  it('refreshes the open drawer when a committed advisor card arrives without stealing focus', async () => {
    const user = userEvent.setup();
    const { rerender } = renderShell(QUEUED_ROOM_VIEW);
    const selected = screen.getByTestId('council-seat-tiffany-aliche');
    await user.click(selected);
    const waitingDrawer = screen.getByRole('dialog');
    expect(waitingDrawer.textContent).toContain('waiting in the queue');
    const close = within(waitingDrawer).getByRole('button', { name: /close/i });
    expect(document.activeElement).toBe(close);

    // Same advisor identity, new committed room snapshot. The drawer must
    // show the current card, not the seat object from the first click.
    rerender(
      <CouncilShell
        room={SAMPLE_ROOM_VIEW}
        medallionSrcBySeat={small}
        medallionLargeSrcBySeat={large}
      />,
    );

    const updatedDrawer = screen.getByRole('dialog');
    expect(updatedDrawer.textContent).toContain(
      'Delivery capacity is unproven at twice the volume',
    );
    expect(updatedDrawer.textContent).toContain('Confirm the cash reserve covers the full pilot cost');
    expect(document.activeElement).toBe(close);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(selected);
  });
});
