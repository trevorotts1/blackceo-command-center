import '../unit/_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB (C8 guard).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DeptCard from '@/components/interview/DeptCard';

// BU-106 / WF-126: on a standard-first box every canonical department is kept by
// default, so a recorded decline must READ as "Will be removed" and must offer
// the one-click "Keep" that reverses it. An undecided card still reads
// "In your workforce" with the "Remove" control.

afterEach(cleanup);

const BASE = {
  id: 'marketing',
  name: 'Marketing',
  oneLiner: 'Campaigns, outreach and the launch calendar.',
  emoji: '📣',
  kind: 'core' as const,
  covered: false,
  standardReady: true,
};

describe('BU-106 — a removed department on a standard-first box', () => {
  it('a declined core card says "Will be removed" and offers Keep', () => {
    const onDecide = vi.fn();
    render(<DeptCard {...BASE} decision="no" onDecide={onDecide} />);

    expect(screen.getByText('Will be removed')).toBeTruthy();
    expect(screen.queryByText('In your workforce')).toBeNull();
    expect(screen.getByText('We will remove this team when your company is built. You can keep it instead.')).toBeTruthy();

    const keep = screen.getByRole('button', { name: 'Keep Marketing in your workforce' });
    expect(keep.textContent).toContain('Keep');
    fireEvent.click(keep);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('yes');
  });

  it('an undecided card says "In your workforce" and offers Remove', () => {
    const onDecide = vi.fn();
    render(<DeptCard {...BASE} decision={null} onDecide={onDecide} />);

    expect(screen.getByText('In your workforce')).toBeTruthy();
    expect(screen.queryByText('Will be removed')).toBeNull();
    const remove = screen.getByRole('button', { name: 'Remove Marketing from your workforce' });
    expect(remove.textContent).toContain('Remove');
    fireEvent.click(remove);
    expect(onDecide).toHaveBeenCalledWith('no');
  });
});
