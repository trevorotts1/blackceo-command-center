import type { Metadata } from 'next';
import BridgeChat from '@/components/operator/BridgeChat';

/**
 * Operator Console / Bridge sub-module page.
 *
 * Wraps the BridgeChat client component in the standard operator layout.
 * The layout itself comes from `src/app/operator/layout.tsx` (the
 * OperatorSidebar plus the CommandPalette mount).
 *
 * The page header is intentionally light because the chat surface is the
 * primary affordance. Donor pattern parity: Agent OS placed the agent
 * switcher at the top of the chat panel, not above it, so the page can
 * stay close to a single dense canvas.
 */

export const metadata: Metadata = {
  title: 'Bridge — Operator Console',
  description:
    'Direct chat with Claude Code, Codex, Antigravity, Hermes, Gemini, Free Claude Code, and OpenClaw.',
};

export default function OperatorBridgePage() {
  return (
    <div className="space-y-5">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console / Bridge
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">
          Talk to your CLIs.
        </h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          One chat surface for every operator-level agent. Pick a CLI in the
          pill strip, type or hit the mic, and every turn auto-saves to a
          per-agent session. Files the CLI creates land in the matching
          scratch directory so the Workspace sub-module can preview them.
        </p>
      </header>

      <BridgeChat />
    </div>
  );
}
