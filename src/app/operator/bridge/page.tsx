import type { Metadata } from 'next';
import BridgeChat from '@/components/operator/BridgeChat';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import ClientCliStatus from '@/components/operator/ClientCliStatus';
import { detectPlatform } from '@/lib/platform';
import { resolveInstallPlatform, visibleBridgeAgents } from '@/lib/bridge/agents';
import { detectAllClis } from '@/lib/bridge/cli-manager';
import { getClientContext } from '@/lib/clients';

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
  title: 'Bridge | Operator Console',
  description:
    'Direct chat with Claude Code, Codex, Antigravity, Hermes, Gemini, Free Claude Code, and OpenClaw.',
};

// Force per-request render so the platform probe (filesystem / env) is read
// at request time on the actual host, not baked in at build time.
export const dynamic = 'force-dynamic';

export default async function OperatorBridgePage() {
  // Compute the visible agents server-side: on a VPS install the six Mac
  // desktop CLIs are hidden, leaving OpenClaw. The list is plain, serializable
  // data so it crosses the server -> client boundary into BridgeChat cleanly.
  const platform = resolveInstallPlatform(detectPlatform);
  const agents = visibleBridgeAgents(platform);

  // E16: detect the agent CLIs (Claude Code, Codex, Antigravity, Hermes,
  // Gemini, OpenClaw) on the SELECTED client's box WITH versions. For a remote
  // client this runs over the Cloudflare Access tunnel; failures degrade
  // softly into a per-CLI error state rather than throwing.
  const client = getClientContext();
  const clientName = client?.name ?? 'this box';
  const clientIsRemote = !!client && !client.is_self;
  const cliStatuses = await detectAllClis(client).catch(() => []);

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console / Bridge
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">
              Talk to your CLIs.
            </h1>
          </div>
          <OperatorHelpButton card="bridge" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          One chat surface for every operator-level agent. Pick a CLI in the
          pill strip, type or hit the mic, and every turn auto-saves to a
          per-agent session. Files the CLI creates land in the matching
          scratch directory so the Workspace sub-module can preview them.
        </p>
      </header>

      <BridgeChat agents={agents} />

      <ClientCliStatus
        clientName={clientName}
        isRemote={clientIsRemote}
        statuses={cliStatuses}
      />
    </div>
  );
}
