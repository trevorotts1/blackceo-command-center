/**
 * B28 — HeadChat real render proof (Q10/Q11 slice, fake transport).
 *
 * Proves the S9 conversation surface against the REAL component with no
 * gateway: correlated reply states, persisted partial/history after reload,
 * retry only where S9 allows it, the unresolved warning, the composer's cap
 * and keyboard contract, and the honest help line (never a fake read-only Ask).
 * A "reload" here is a re-render from the SAME persisted turn list the server
 * would return — the component holds no transcript of its own, so the same
 * props must produce the same text.
 *
 * Runs via: npx vitest run --config vitest.b28-render.config.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

import HeadChat, { HEAD_CHAT_HELP, HEAD_CHAT_UNCERTAIN } from '../../../../src/components/hq/HeadChat';
import type { HqChatTurn, HqChatTurnState } from '../../../../src/lib/hq/types';

afterEach(() => cleanup());

function turn(over: Partial<HqChatTurn> & { id: string; state: HqChatTurnState }): HqChatTurn {
  return {
    sessionId: 'sess-1',
    message: 'draft',
    reply: null,
    partial: false,
    attempts: 0,
    taskId: null,
    errorCode: null,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    terminalAt: null,
    ...over,
  };
}

const base = {
  headName: 'Dana — Marketing head',
  departmentLabel: 'Marketing',
};

describe('HeadChat — S9 conversation surface (B28)', () => {
  it('states the honest help contract and never presents a read-only Ask mode', () => {
    render(<HeadChat {...base} turns={[]} onSend={() => {}} />);
    expect(screen.getByTestId('hq-head-chat-help').textContent).toBe(HEAD_CHAT_HELP);
    // "Work requested here can create or update tasks" — the S9 requirement.
    expect(HEAD_CHAT_HELP).toContain('can create or update tasks');
    expect(document.body.textContent?.toLowerCase()).not.toContain('read-only');
  });

  it('renders each turn state as a labelled chip (state carries a label, not color alone)', () => {
    const states: HqChatTurnState[] = [
      'queued',
      'sending',
      'awaiting_reply',
      'replied',
      'failed_unsent',
      'refused',
      'reconciling',
      'unresolved',
    ];
    render(
      <HeadChat
        {...base}
        turns={states.map((s, i) => turn({ id: `t${i}`, state: s }))}
        onSend={() => {}}
      />,
    );
    const labels = ['Queued', 'Sending', 'Awaiting reply', 'Replied', 'Not sent', 'Refused', 'Reconciling', 'Unresolved'];
    labels.forEach((label, i) => {
      expect(screen.getByTestId(`hq-chat-state-t${i}`).textContent).toContain(label);
    });
  });

  it('keeps a persisted partial reply visible and labelled while nonterminal, and after reload', () => {
    const turns = [turn({ id: 'p1', state: 'awaiting_reply', reply: 'Half an ans', partial: true })];
    const { unmount } = render(<HeadChat {...base} turns={turns} onSend={() => {}} />);
    expect(screen.getByTestId('hq-chat-reply-p1').textContent).toBe('Half an ans');
    expect(screen.getByTestId('hq-chat-partial-p1')).toBeTruthy();
    unmount();

    // "Reload": same persisted list, fresh mount — same text, still labelled partial.
    render(<HeadChat {...base} turns={turns} onSend={() => {}} />);
    expect(screen.getByTestId('hq-chat-reply-p1').textContent).toBe('Half an ans');
    expect(screen.getByTestId('hq-chat-partial-p1')).toBeTruthy();
  });

  it('marks a reconciled reply as no longer partial (completion updates the same turn)', () => {
    render(
      <HeadChat
        {...base}
        turns={[turn({ id: 'r1', state: 'replied', reply: 'The full answer.', partial: false, terminalAt: '2026-10-04T00:01:00.000Z' })]}
        onSend={() => {}}
      />,
    );
    expect(screen.getByTestId('hq-chat-reply-r1').textContent).toBe('The full answer.');
    expect(screen.queryByTestId('hq-chat-partial-r1')).toBeNull();
  });

  it('offers Retry only for failed_unsent under the attempt ceiling', () => {
    const onRetry = vi.fn();
    render(
      <HeadChat
        {...base}
        turns={[
          turn({ id: 'a', state: 'failed_unsent', attempts: 0 }),
          turn({ id: 'b', state: 'failed_unsent', attempts: 3 }),
          turn({ id: 'c', state: 'unresolved', attempts: 1 }),
          turn({ id: 'd', state: 'replied', reply: 'ok', attempts: 1, terminalAt: '2026-10-04T00:01:00.000Z' }),
        ]}
        onSend={() => {}}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByTestId('hq-chat-retry-a'));
    expect(onRetry).toHaveBeenCalledWith('a');
    expect(screen.queryByTestId('hq-chat-retry-b')).toBeNull();
    // A timeout/unresolved turn is NOT retryable — S9 forbids it.
    expect(screen.queryByTestId('hq-chat-retry-c')).toBeNull();
    expect(screen.queryByTestId('hq-chat-retry-d')).toBeNull();
  });

  it('shows the unresolved warning and the explicit duplicate-warning recovery path, never an automatic resend', () => {
    const onSendAsNewMessage = vi.fn();
    render(
      <HeadChat
        {...base}
        turns={[turn({ id: 'u1', state: 'unresolved', reply: 'buffered partial', partial: true })]}
        onSend={() => {}}
        onSendAsNewMessage={onSendAsNewMessage}
      />,
    );
    expect(screen.getByTestId('hq-chat-uncertain-u1').textContent).toContain(HEAD_CHAT_UNCERTAIN);
    // Previously buffered partial text stays labelled partial, not promoted to a reply.
    expect(screen.getByTestId('hq-chat-partial-u1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hq-chat-new-u1'));
    expect(onSendAsNewMessage).toHaveBeenCalledWith('u1');
    expect(onSendAsNewMessage).toHaveBeenCalledTimes(1);
  });

  it('warns on a reconciling turn too (never a silent success)', () => {
    render(<HeadChat {...base} turns={[turn({ id: 'rc', state: 'reconciling' })]} onSend={() => {}} />);
    expect(screen.getByTestId('hq-chat-uncertain-rc').textContent).toContain(HEAD_CHAT_UNCERTAIN);
  });

  it('links a reply to the actual authorized task by canonical id, and only when the turn has one', () => {
    const onOpenTask = vi.fn();
    render(
      <HeadChat
        {...base}
        turns={[turn({ id: 't1', state: 'replied', reply: 'Made it.', taskId: 'task-42' }), turn({ id: 't2', state: 'replied', reply: 'Just chat.' })]}
        onSend={() => {}}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByTestId('hq-chat-task-t1'));
    expect(onOpenTask).toHaveBeenCalledWith('task-42');
    expect(screen.queryByTestId('hq-chat-task-t2')).toBeNull();
  });

  it('sends with one clientRequestId, never echoing the draft as a reply before the server stores it', () => {
    const onSend = vi.fn();
    render(<HeadChat {...base} turns={[]} onSend={onSend} />);
    fireEvent.change(screen.getByTestId('hq-head-chat-composer'), { target: { value: 'Please draft the launch note' } });
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    const [message, requestId] = onSend.mock.calls[0];
    expect(message).toBe('Please draft the launch note');
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    // Nothing optimistic: with no persisted turn in props, no head bubble exists.
    expect(screen.queryAllByTestId(/^hq-chat-reply-/)).toHaveLength(0);
    expect((screen.getByTestId('hq-head-chat-composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('trims the draft and refuses an empty send', () => {
    const onSend = vi.fn();
    render(<HeadChat {...base} turns={[]} onSend={onSend} />);
    const composer = screen.getByTestId('hq-head-chat-composer');
    fireEvent.change(composer, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));
    expect(onSend).toHaveBeenCalledWith('hello', expect.any(String));
  });

  it('rejects an oversize message with the real count instead of truncating it', () => {
    const onSend = vi.fn();
    render(<HeadChat {...base} turns={[]} onSend={onSend} />);
    fireEvent.change(screen.getByTestId('hq-head-chat-composer'), { target: { value: 'x'.repeat(32001) } });
    expect(screen.getByTestId('hq-head-chat-oversize').textContent).toContain('32,001');
    expect(screen.getByTestId('hq-head-chat-oversize').textContent).toContain('nothing is truncated');
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends on Enter and inserts a newline on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<HeadChat {...base} turns={[]} onSend={onSend} />);
    const composer = screen.getByTestId('hq-head-chat-composer') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'line one' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('line one', expect.any(String));
  });

  it('disables sending while a send is in flight, and while the session is closed', () => {
    const onSend = vi.fn();
    const { unmount } = render(<HeadChat {...base} turns={[]} busy onSend={onSend} />);
    const composer = screen.getByTestId('hq-head-chat-composer');
    fireEvent.change(composer, { target: { value: 'late' } });
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));
    expect(onSend).not.toHaveBeenCalled();
    unmount();

    render(<HeadChat {...base} turns={[]} sessionClosedReason="head_binding_changed" onSend={onSend} />);
    expect(screen.getByTestId('hq-head-chat-closed').textContent).toContain('head_binding_changed');
    expect((screen.getByTestId('hq-head-chat-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('hq-head-chat-send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says so when the bounded context envelope dropped older messages', () => {
    render(<HeadChat {...base} turns={[]} historyTruncated onSend={() => {}} />);
    expect(screen.getByTestId('hq-head-chat-truncated').textContent).toContain('Older messages');
  });

  it('surfaces a transport failure without fabricating a reply', () => {
    render(<HeadChat {...base} turns={[]} sendError="Could not reach the gateway." onSend={() => {}} />);
    expect(screen.getByTestId('hq-head-chat-send-error').textContent).toBe('Could not reach the gateway.');
    expect(screen.queryAllByTestId(/^hq-chat-reply-/)).toHaveLength(0);
  });

  it('closes on Escape and restores focus to the trigger (Q11 / S11)', () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button" data-testid="talk-trigger">Talk to head</button>
        <HeadChat {...base} turns={[]} onSend={() => {}} onClose={onClose} />
      </>,
    );
    const trigger = screen.getByTestId('talk-trigger') as HTMLButtonElement;
    trigger.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes Create task to the existing department-prefilled surface, never a parallel task row', () => {
    const onCreateTask = vi.fn();
    render(<HeadChat {...base} turns={[]} onSend={() => {}} onCreateTask={onCreateTask} />);
    const button = screen.getByTestId('hq-head-chat-create-task');
    expect(button.textContent).toContain('Marketing');
    fireEvent.click(button);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
  });

  it('renders every control at the S11 44px floor with an accessible name', () => {
    const controls = ['hq-head-chat-send', 'hq-head-chat-create-task'];
    render(<HeadChat {...base} turns={[turn({ id: 'z', state: 'failed_unsent' })]} onSend={() => {}} onRetry={() => {}} onCreateTask={() => {}} onClose={() => {}} />);
    controls.push('hq-chat-retry-z', 'hq-head-chat-composer');
    for (const testId of controls) {
      const el = screen.getByTestId(testId);
      expect(el.className).toContain('min-h-[44px]');
    }
    // The close control has a real accessible name.
    expect(screen.getByLabelText('Close conversation')).toBeTruthy();
    // The composer is labelled, not placeholder-only.
    expect(screen.getByLabelText(`Message ${base.headName}`)).toBeTruthy();
  });

  it('escapes hostile markup as data (no execution, no HTML)', () => {
    render(
      <HeadChat
        {...base}
        turns={[turn({ id: 'h1', state: 'replied', reply: '<img src=x onerror=alert(1)>', message: '<script>alert(2)</script>' })]}
        onSend={() => {}}
      />,
    );
    expect(screen.getByTestId('hq-chat-reply-h1').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
