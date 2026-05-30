'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import {
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
  ArrowUpRight,
} from 'lucide-react';
import type { ReactNode } from 'react';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import {
  ModuleHealthDotFromPayload,
  useModuleHealth,
  type ModuleHealthPayload,
} from '@/components/operator/ModuleHealthDot';
import type { ModuleId } from '@/lib/operator/module-health';

interface OperatorTile {
  href: string;
  title: string;
  tagline: string;
  icon: ReactNode;
  accent: string;
  /** Walkthrough card id for the per-tile "What is this?" affordance. */
  cardId: string;
  /** When set, this tile persists and shows a vault-health dot. */
  healthModule?: ModuleId;
  /** Wave 1 placeholder: route is not yet implemented at this depth. */
  placeholder?: boolean;
}

const TILES: OperatorTile[] = [
  {
    href: '/operator/bridge',
    title: 'Bridge',
    tagline: 'Chat with Claude, Codex, Antigravity, Hermes, Gemini, FCC, and OpenClaw.',
    icon: <MessageSquare size={22} />,
    accent: '#3B82F6',
    cardId: 'bridge',
  },
  {
    href: '/operator/workspace',
    title: 'Workspace',
    tagline: 'Per-agent scratch directories with inline file preview.',
    icon: <FolderOpen size={22} />,
    accent: '#8B5CF6',
    cardId: 'workspace',
  },
  {
    href: '/operator/studio',
    title: 'Studio',
    tagline: 'Image, video, and audio generation via Kie.ai, Fal.ai, and more.',
    icon: <Wand2 size={22} />,
    accent: '#EC4899',
    cardId: 'studio',
    healthModule: 'studio',
  },
  {
    href: '/operator/notebook',
    title: 'Notebook',
    tagline: 'NotebookLM-style document Q&A grounded in your sources.',
    icon: <NotebookText size={22} />,
    accent: '#F59E0B',
    cardId: 'notebook',
    healthModule: 'notebook',
  },
  {
    href: '/operator/goals',
    title: 'Goals',
    tagline: 'Personal goal tracker writing straight to the vault.',
    icon: <Target size={22} />,
    accent: '#FBBF24',
    cardId: 'goals',
    healthModule: 'goals',
  },
  {
    href: '/operator/journal',
    title: 'Journal',
    tagline: 'One markdown file per day. Voice or text, your call.',
    icon: <BookOpen size={22} />,
    accent: '#A3E635',
    cardId: 'journal',
    healthModule: 'journal',
  },
  {
    href: '/operator/memory',
    title: 'Memory',
    tagline: 'Full-text search across vault notes and chat history.',
    icon: <Brain size={22} />,
    accent: '#22D3EE',
    cardId: 'memory',
  },
  {
    href: '/operator/research',
    title: 'Research',
    tagline: 'Live X/Twitter search through xAI Grok.',
    icon: <Search size={22} />,
    accent: '#06B6D4',
    cardId: 'research',
    healthModule: 'research',
  },
  {
    href: '/operator/call',
    title: 'Call Mode',
    tagline: 'Hands-free voice conversation with the operator-level CLIs.',
    icon: <Phone size={22} />,
    accent: '#10B981',
    cardId: 'call',
  },
  {
    href: '/operator/web-agent',
    title: 'Web Agent',
    tagline: 'Browser automation through Anthropic Computer Use.',
    icon: <Globe size={22} />,
    accent: '#6366F1',
    cardId: 'web-agent',
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};

const tileVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 220, damping: 22 },
  },
};

export default function OperatorLandingPage() {
  // One shared poll of /api/operator/health feeds every tile's vault-health dot.
  const { data: health } = useModuleHealth();

  return (
    <div className="space-y-10">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">
              Pick a sub-module to dive in.
            </h1>
          </div>
          <OperatorHelpButton label="Show walkthrough" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[640px]">
          The Operator Console is your direct line to operator-level CLIs,
          creative tools, and personal vault. Each tile opens a focused
          sub-module. Use <span className="font-mono text-[13px]">Cmd K</span> for
          fast navigation. New here? Tap <span className="font-medium">Show
          walkthrough</span>.
        </p>
      </header>

      <motion.section
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        aria-label="Operator Console sub-modules"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {TILES.map((tile) => {
            const healthRow = tile.healthModule
              ? health?.modules.find((m) => m.module === tile.healthModule) ?? null
              : null;
            return (
              <motion.div key={tile.href} variants={tileVariants}>
                <OperatorTileCard tile={tile} healthRow={healthRow} />
              </motion.div>
            );
          })}
        </div>
      </motion.section>
    </div>
  );
}

function OperatorTileCard({
  tile,
  healthRow,
}: {
  tile: OperatorTile;
  healthRow: ModuleHealthPayload | null;
}) {
  const content = (
    <div
      className={`group relative overflow-hidden h-full rounded-xl border border-bcc-border bg-bcc-white p-5 transition-shadow ${
        tile.placeholder ? 'opacity-70' : 'hover:shadow-md'
      }`}
    >
      <div
        className="pointer-events-none absolute -bottom-16 -right-12 w-44 h-44 rounded-full blur-3xl opacity-10 group-hover:opacity-20 transition-opacity"
        style={{ background: tile.accent }}
      />
      <div className="relative flex items-start justify-between mb-3">
        <div
          className="grid place-items-center w-10 h-10 rounded-lg"
          style={{
            background: `${tile.accent}1a`,
            color: tile.accent,
            border: `1px solid ${tile.accent}33`,
          }}
        >
          {tile.icon}
        </div>
        {tile.placeholder ? (
          <span className="text-[10px] uppercase tracking-[0.18em] px-2 py-1 rounded-full bg-bcc-border-light text-bcc-text-muted font-semibold">
            Wave 1
          </span>
        ) : (
          <ArrowUpRight
            size={16}
            className="text-bcc-text-muted opacity-60 group-hover:opacity-100 transition-opacity"
          />
        )}
      </div>
      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-card-title text-bcc-text">{tile.title}</h2>
          {tile.healthModule && (
            <ModuleHealthDotFromPayload row={healthRow} showLabel />
          )}
        </div>
        <p className="mt-1.5 text-[14px] text-bcc-text-secondary leading-relaxed">
          {tile.tagline}
        </p>
      </div>
    </div>
  );

  if (tile.placeholder) {
    return (
      <div
        role="link"
        aria-disabled="true"
        title="Ships at Wave 1"
        className="block h-full cursor-not-allowed"
      >
        {content}
      </div>
    );
  }

  return (
    <Link href={tile.href} className="block h-full">
      {content}
    </Link>
  );
}
