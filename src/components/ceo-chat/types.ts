/**
 * Shared types for the My AI CEO component set (U60 / JM-U63a).
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'trust';
  content: string;
  kind: string;
  task_id: string | null;
  created_at: string;
  attachment_name?: string | null;
}

export interface SpawnedTask {
  id: string;
  title: string;
  status: string;
  department: string | null;
  updated_at: string;
}

export interface ModelOption {
  model_id: string;
  label: string;
  provider: string;
  context_window: number | null;
  capabilities: string[];
}

export interface AgentOption {
  id: string;
  name: string;
  avatar_emoji: string;
  is_master: boolean;
  status: string;
}

export interface DepartmentOption {
  id: string;
  emoji: string;
  name: string;
}

/**
 * Thinking-level UI labels. U62 (JM/U65): the U61/S1 gateway spike proved the
 * accepted-and-landing set for the default model is exactly
 * {off, low, medium, high} — these four labels are now LIVE (ThinkingSelector
 * is no longer read-only) and map 1:1 onto those proven values. The mapping
 * itself (and the GatewayThinkingLevel type gateway.ts/the API route use) now
 * lives in `@/lib/ceo-chat/thinking-level` — re-exported here so this file
 * stays the single import site every ceo-chat component already uses.
 */
export { THINKING_LEVELS, type ThinkingLevel } from '@/lib/ceo-chat/thinking-level';

/** Mobile `Conversation | What's happening (n)` tab ids (spec (g)). */
export type MobileTab = 'conversation' | 'happening';
