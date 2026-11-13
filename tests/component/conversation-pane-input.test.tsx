import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import ConversationPane from '@/components/interview/ConversationPane';

// jsdom has no layout engine, and the pane's auto-scroll effect reaches for it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

/** Minimal parent: holds the controlled input the way InterviewClient does. */
function Harness({
  currentQuestion,
  onSend,
}: {
  currentQuestion: string;
  onSend: () => void;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <ConversationPane
      currentReaction=""
      currentQuestion={currentQuestion}
      input={input}
      onInput={setInput}
      onSend={onSend}
      onIDontKnow={vi.fn()}
      sending={false}
      sessionId={null}
      scrollRef={scrollRef}
    />
  );
}

describe('ConversationPane keeps the typing box on the conversation screen', () => {
  it('shows an enabled answer box before the first question and sends what is typed', () => {
    const onSend = vi.fn();
    render(<Harness currentQuestion="" onSend={onSend} />);

    // The ready line replaces the spinner-only waiting block.
    expect(screen.getByText(/One moment — getting ready/)).toBeTruthy();

    const box = screen.getByPlaceholderText(
      'Type or speak your answer…',
    ) as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    expect(box.disabled).toBe(false);

    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
