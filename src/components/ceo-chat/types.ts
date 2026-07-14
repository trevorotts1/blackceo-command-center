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

/** Gateway-spike-gated (U64) thinking levels — rendered read-only until U65. */
export const THINKING_LEVELS = ['Quick', 'Balanced', 'Deep', 'Max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Mobile `Conversation | What's happening (n)` tab ids (spec (g)). */
export type MobileTab = 'conversation' | 'happening';
