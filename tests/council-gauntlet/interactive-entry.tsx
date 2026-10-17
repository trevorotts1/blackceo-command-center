/**
 * interactive-entry.tsx — CWE-044 gauntlet interactive harness page.
 *
 * Bundled with esbuild (see build-interactive.mjs) and loaded by
 * gauntlet-interactive.html in a real Chromium. It mounts the tree's
 * REAL CouncilShell (room, view toggle, seat drawer) and CouncilVerdict
 * (with the source drawer wired the way the composed [sessionId] page
 * wires it) over the tree's own synthetic fixtures, so the keyboard
 * suite (suite-keyboard.mjs) exercises genuine component behavior:
 * Tab order, focus visibility, drawer focus trap and restore, view
 * toggle, reduced-motion mirroring. Fixture data only.
 */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/components/council/council-theme.css';
import '../../src/components/council/council-room.css';
import '../../src/components/council/council-journey.css';
import { CouncilShell } from '../../src/components/council/CouncilShell';
import { CouncilVerdict } from '../../src/components/council/CouncilVerdict';
import { CouncilSourceDrawer } from '../../src/components/council/CouncilSourceDrawer';
import {
  SAMPLE_ROOM_VIEW,
} from '../../src/components/council/council-room-fixtures';
import {
  FIXTURE_BRIEF,
  FIXTURE_CARDS,
  FIXTURE_OPTION_LABELS,
  FIXTURE_SESSION_ID,
  FIXTURE_VERDICT_READ,
} from '../../src/components/council/council-session-fixtures';
import {
  buildSeatSources,
  type SeatSources,
} from '../../src/components/council/council-session-types';

declare global {
  interface Window {
    __GAUNTLET_MEDALLIONS__?: {
      small: Record<string, string>;
      large: Record<string, string>;
    };
  }
}

function Harness() {
  const medallions = useMemo(
    () =>
      window.__GAUNTLET_MEDALLIONS__ ?? { small: {}, large: {} },
    [],
  );
  const [sourceSeat, setSourceSeat] = useState<string | null>(null);
  const sources: SeatSources | null = useMemo(() => {
    if (!sourceSeat) return null;
    return buildSeatSources(
      sourceSeat,
      FIXTURE_CARDS,
      FIXTURE_BRIEF,
      'bibliographic_only',
    );
  }, [sourceSeat]);

  return (
    <main>
      <CouncilShell
        room={SAMPLE_ROOM_VIEW}
        medallionSrcBySeat={medallions.small}
        medallionLargeSrcBySeat={medallions.large}
      />
      <CouncilVerdict
        verdictRead={FIXTURE_VERDICT_READ}
        optionLabels={FIXTURE_OPTION_LABELS}
        cards={FIXTURE_CARDS}
        brief={FIXTURE_BRIEF}
        mode="live"
        sessionId={FIXTURE_SESSION_ID}
        onOpenSources={setSourceSeat}
        createExport={() => new Promise(() => undefined)}
      />
      <CouncilSourceDrawer
        sources={sources}
        onClose={() => setSourceSeat(null)}
      />
    </main>
  );
}

const rootEl = document.getElementById('gauntlet-root');
if (rootEl) {
  createRoot(rootEl).render(<Harness />);
}
