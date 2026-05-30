/**
 * Operator Console onboarding card content (Feature 1).
 *
 * Plain-English, 60-year-old-friendly copy explaining each Operator Console
 * sub-module — one card each. Kept as data (not JSX) so the same source drives
 * BOTH the first-run walkthrough overlay (OperatorOnboarding.tsx) and the
 * per-page "What is this?" help affordance (OperatorHelpButton.tsx).
 *
 * The card order intentionally matches OPERATOR_NAV in OperatorSidebar.tsx.
 * The MEMORY card carries the platform-specific note (Mac Mini vs VPS): on a
 * Mac you can ALSO browse the vault in Obsidian; on a VPS there is no Obsidian,
 * so the Memory page IS your window into the brain. The note text is resolved
 * at render time from the detected platform.
 */

import type { Platform } from '@/lib/platform';

export interface OnboardingCard {
  /** Stable id; matches the sub-module href tail (e.g. 'bridge', 'memory'). */
  id: string;
  /** Sidebar/console title. */
  title: string;
  /** One-line summary shown under the title. */
  summary: string;
  /** Plain-English body, 1–3 short sentences. */
  body: string;
  /** Accent color (matches OPERATOR_NAV/TILES accents). */
  accent: string;
  /** Wave 1 placeholder modules ("Soon"). */
  soon?: boolean;
}

export const ONBOARDING_CARDS: OnboardingCard[] = [
  {
    id: 'console',
    title: 'Console',
    summary: 'Your home base.',
    body: 'This is the front door to the Operator Console. Every tool below has a tile here. Pick one to dive in, or press Cmd+K (Ctrl+K on Windows) to jump straight to any of them.',
    accent: '#43A047',
  },
  {
    id: 'bridge',
    title: 'Bridge',
    summary: 'Talk to your AI command-line tools and OpenClaw.',
    body: 'A chat window straight to your AI helpers — Claude, Codex, Antigravity, Hermes, Gemini, FCC, and your OpenClaw agent. Type a request and the tool does the work. On a cloud (VPS) box you will only see the OpenClaw button; the desktop tools live on the Mac Mini.',
    accent: '#3B82F6',
  },
  {
    id: 'workspace',
    title: 'Workspace',
    summary: 'See the files your tools create.',
    body: 'When a tool writes a file, it lands here in its own folder. Click any file to preview it right in the page — no digging through folders on your computer.',
    accent: '#8B5CF6',
  },
  {
    id: 'studio',
    title: 'Studio',
    summary: 'Make images, video, and audio.',
    body: 'Describe what you want and Studio generates a picture, a short video, or a voice clip for you. Finished pieces are saved into your vault automatically so you never lose them.',
    accent: '#EC4899',
  },
  {
    id: 'notebook',
    title: 'Notebook',
    summary: 'Ask questions about your own documents.',
    body: 'Drop in sources on a topic and ask questions — the answers come only from what you put in, not the open internet. Great for keeping a subject organized and grounded.',
    accent: '#F59E0B',
  },
  {
    id: 'goals',
    title: 'Goals',
    summary: 'A simple checklist that saves to your vault.',
    body: 'Write down what you are working toward. Each goal is also written to a plain text file (goals.md) in your vault, so it shows up in Memory search and in Obsidian on a Mac.',
    accent: '#FBBF24',
  },
  {
    id: 'journal',
    title: 'Journal',
    summary: 'One short entry per day.',
    body: 'Jot down how the day went, by typing or by voice. Each day becomes its own dated file in your vault, so your whole history is searchable later.',
    accent: '#A3E635',
  },
  {
    id: 'memory',
    title: 'Memory',
    summary: 'Search everything you and your AI have written.',
    body: 'Everything you write in the Console — goals, journal entries, notes, research — flows into your vault, and Memory lets you search all of it from one box. Think of it as the search bar for your whole AI brain.',
    accent: '#22D3EE',
  },
  {
    id: 'research',
    title: 'Research',
    summary: 'Live web and X search, saved for later.',
    body: 'Ask a question and get a fresh answer pulled from the live web and X (Twitter), with sources listed. Every result is saved into your vault so you can find it again in Memory.',
    accent: '#06B6D4',
  },
  {
    id: 'call',
    title: 'Call Mode',
    summary: 'Hands-free voice chat (coming soon).',
    body: 'Soon you will be able to just talk to your AI tools out loud, like a phone call, instead of typing.',
    accent: '#10B981',
    soon: true,
  },
  {
    id: 'web-agent',
    title: 'Web Agent',
    summary: 'Let the AI use a web browser (coming soon).',
    body: 'Soon the AI will be able to click around websites and fill in forms for you, all on its own.',
    accent: '#6366F1',
    soon: true,
  },
];

/** Look up one card by its id (sub-module slug). */
export function getOnboardingCard(id: string): OnboardingCard | undefined {
  return ONBOARDING_CARDS.find((c) => c.id === id);
}

/**
 * The Mac-vs-VPS Memory note. Returned separately so the Memory card can append
 * the right sentence for the box the operator is actually on.
 *
 *   mac-mini   → you can ALSO open the vault in Obsidian to browse it visually.
 *   vps-docker → there is no Obsidian on a cloud box; the Memory page IS your
 *                window into the brain.
 */
export function memoryPlatformNote(platform: Platform): string {
  if (platform === 'mac-mini') {
    return 'You are on a Mac Mini, so you can ALSO open your vault folder in Obsidian to read and browse everything by hand. Memory and Obsidian look at the same files.';
  }
  return 'You are on a cloud (VPS) box, which does not run Obsidian. That is normal — here, this Memory page IS your window into the brain. Everything lives in the vault and you read it through Memory.';
}
