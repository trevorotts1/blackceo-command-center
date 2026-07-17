/**
 * U62 (JM/U65, master E.2) — ModelPicker / AgentPicker go interactive.
 *
 * Pre-U62 both pickers auto-resolved a default on mount and then rendered a
 * PERMANENTLY disabled trigger ("Model is set box-wide for now" / "Direct
 * agent chat is coming") — Phase A explicitly deferred live switching to
 * U65. U61/S2 PASSed (the proven `sessions.create` `key` addressing), so
 * BINARY acceptance now requires: "model mid-thread change inserts exactly
 * one system chip and updates the denominator"; "agent switch ... switching
 * locked mid-stream". This suite distinguishes the MOUNT-TIME auto-resolve
 * (must still fire `onResolved`, must NOT fire the new user-change callback)
 * from an explicit USER pick (fires BOTH), and proves the streaming-lock
 * degrade state via a real DOM disabled attribute + honest tooltip — never a
 * silently-vanished control.
 *
 * Renders the REAL components (@testing-library/react + jsdom). `global.fetch`
 * is stubbed per test, throwing on any unlisted URL so a regression that adds
 * a different endpoint call is caught by the actual component's actual effect
 * (same discipline as u47-health-indicator.test.tsx).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import ModelPicker from '../../src/components/ceo-chat/ModelPicker';
import AgentPicker from '../../src/components/ceo-chat/AgentPicker';
import type { ModelOption, AgentOption } from '../../src/components/ceo-chat/types';

afterEach(() => cleanup());

const MODELS: ModelOption[] = [
  { model_id: 'ollama-cloud/llama3.3:70b', label: 'Llama 3.3 70B', provider: 'ollama-cloud', context_window: 128_000, capabilities: ['text'] },
  { model_id: 'ollama/deepseek-v4-flash:cloud', label: 'DeepSeek v4 Flash', provider: 'ollama', context_window: 64_000, capabilities: ['text', 'reasoning'] },
];

const AGENTS: AgentOption[] = [
  { id: 'main', name: 'Main', avatar_emoji: '🤖', is_master: true, status: 'active' },
  { id: 'bug-fix-triager', name: 'Bug Fix Triager', avatar_emoji: '🐛', is_master: false, status: 'active' },
];

function stubModelFetch() {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('/api/models')) {
      return new Response(JSON.stringify({ models: MODELS }), { status: 200 });
    }
    if (u.startsWith('/api/openclaw/models')) {
      return new Response(JSON.stringify({ defaultModel: MODELS[0].model_id }), { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${u}`);
  }) as unknown as typeof fetch;
}

function stubAgentFetch() {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('/api/agents')) {
      return new Response(JSON.stringify({ agents: AGENTS }), { status: 200 });
    }
    throw new Error(`unstubbed fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('ModelPicker — interactive (U62)', () => {
  beforeEach(() => stubModelFetch());

  it('auto-resolves the box default on mount via onResolved, WITHOUT firing onUserChange', async () => {
    const onResolved = vi.fn();
    const onUserChange = vi.fn();
    render(<ModelPicker onResolved={onResolved} onUserChange={onUserChange} />);

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ model_id: MODELS[0].model_id })));
    expect(onUserChange).not.toHaveBeenCalled();
  });

  it('opening the trigger and picking a DIFFERENT model fires BOTH onResolved and onUserChange with the new model', async () => {
    const onResolved = vi.fn();
    const onUserChange = vi.fn();
    render(<ModelPicker onResolved={onResolved} onUserChange={onUserChange} />);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('control-model-picker'));
    const option = await screen.findByText('DeepSeek v4 Flash');
    fireEvent.click(option);

    expect(onResolved).toHaveBeenLastCalledWith(expect.objectContaining({ model_id: 'ollama/deepseek-v4-flash:cloud' }));
    expect(onUserChange).toHaveBeenCalledTimes(1);
    expect(onUserChange).toHaveBeenCalledWith(expect.objectContaining({ model_id: 'ollama/deepseek-v4-flash:cloud' }));
  });

  it('disabled=true (streaming) never opens the menu and carries the honest tooltip — never silently vanishes', async () => {
    const onUserChange = vi.fn();
    render(<ModelPicker onResolved={() => {}} onUserChange={onUserChange} disabled disabledReason="Model switch is locked while your AI CEO is replying." />);
    await waitFor(() => screen.getByTestId('control-model-picker'));

    const trigger = screen.getByTestId('control-model-picker') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('title')).toBe('Model switch is locked while your AI CEO is replying.');
    fireEvent.click(trigger);
    expect(screen.queryByText('DeepSeek v4 Flash')).toBeNull();
    expect(onUserChange).not.toHaveBeenCalled();
  });
});

describe('AgentPicker — interactive (U62)', () => {
  beforeEach(() => stubAgentFetch());

  it('auto-resolves the master agent on mount via onResolved, WITHOUT firing onUserChange', async () => {
    const onResolved = vi.fn();
    const onUserChange = vi.fn();
    render(<AgentPicker onResolved={onResolved} onUserChange={onUserChange} />);

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'main' })));
    expect(onUserChange).not.toHaveBeenCalled();
  });

  it('opening the trigger and picking a DIFFERENT agent fires BOTH onResolved and onUserChange with the new agent', async () => {
    const onResolved = vi.fn();
    const onUserChange = vi.fn();
    render(<AgentPicker onResolved={onResolved} onUserChange={onUserChange} />);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('control-agent-picker'));
    const option = await screen.findByText(/Bug Fix Triager/);
    fireEvent.click(option);

    expect(onResolved).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'bug-fix-triager' }));
    expect(onUserChange).toHaveBeenCalledTimes(1);
    expect(onUserChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'bug-fix-triager' }));
  });

  it('disabled=true (streaming) never opens the menu and carries the honest tooltip', async () => {
    const onUserChange = vi.fn();
    render(<AgentPicker onResolved={() => {}} onUserChange={onUserChange} disabled disabledReason="Agent switch is locked while your AI CEO is replying." />);
    await waitFor(() => screen.getByTestId('control-agent-picker'));

    const trigger = screen.getByTestId('control-agent-picker') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('title')).toBe('Agent switch is locked while your AI CEO is replying.');
    fireEvent.click(trigger);
    expect(screen.queryByText(/Bug Fix Triager/)).toBeNull();
    expect(onUserChange).not.toHaveBeenCalled();
  });
});
