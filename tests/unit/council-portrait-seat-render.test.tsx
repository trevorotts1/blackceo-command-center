import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useCouncilPortraitRelease } from '../../src/components/council/useCouncilPortraitRelease';
import { readApprovedCouncilPortraitRelease } from '../../src/components/council/council-portrait-manifest';
vi.mock('../../src/components/council/council-portrait-manifest', () => ({ readApprovedCouncilPortraitRelease: vi.fn() }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdvisorSeat, isApprovedCouncilRoomPortrait,
} from '../../src/components/council/AdvisorSeat';
import {
  SAMPLE_ROOM_VIEW,
  fixtureMedallionSrcs,
} from '../../src/components/council/council-room-fixtures';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const seat = SAMPLE_ROOM_VIEW.seats.find((candidate) => candidate.seatId === 'simon-sinek');
if (!seat) throw new Error('canonical Simon Sinek fixture is missing');
const fallback = fixtureMedallionSrcs('/portraits').small;

describe('WER-018 nine-person portrait-aware room seat', () => {
  it('loads released room/detail maps for the mounted page and aborts lookup on unmount', async () => {
    const release = { status: 'approved' as const, images: { roomSrcBySeat: {}, detailSrcBySeat: {}, thumbSrcBySeat: {} } };
    vi.mocked(readApprovedCouncilPortraitRelease).mockResolvedValue(release as never);
    const hook = renderHook(() => useCouncilPortraitRelease());
    await waitFor(() => expect(hook.result.current).toEqual(release));
    const signal = vi.mocked(readApprovedCouncilPortraitRelease).mock.calls[0][1];
    expect(signal?.aborted).toBe(false);
    hook.unmount();
    expect(signal?.aborted).toBe(true);
    const page = readFileSync(join(process.cwd(), 'src/app/council/[sessionId]/page.tsx'), 'utf8');
    expect(page).toContain('useCouncilPortraitRelease()');
    expect(page).toContain('portraits.images.roomSrcBySeat');
    expect(page).toContain('portraits.images.detailSrcBySeat');
  });

  it('preserves the unavailable state so missing pictures are not presented as portraits', async () => {
    vi.mocked(readApprovedCouncilPortraitRelease).mockResolvedValue({ status: 'unavailable', reason: 'missing pictures' });
    const hook = renderHook(() => useCouncilPortraitRelease());
    await waitFor(() => expect(hook.result.current?.status).toBe('unavailable'));
  });
  it('renders an approved canonical portrait at the large room size with full identity and status', () => {
    const path = '/council/portraits/simon-sinek-room.webp';
    render(<AdvisorSeat seat={seat} medallionSrc={path} variant="room" />);
    const button = screen.getByTestId('council-seat-simon-sinek');
    expect(button.getAttribute('data-has-portrait')).toBe('true');
    expect(button.getAttribute('aria-label')).toContain('Simon Sinek');
    const portrait = screen.getByTestId('council-portrait-simon-sinek');
    expect(portrait.getAttribute('src')).toBe(path);
    expect(portrait.getAttribute('width')).toBe('116');
    expect(portrait.getAttribute('height')).toBe('145');
    expect(portrait.getAttribute('alt')).toContain('Simon Sinek');
    expect(button.textContent).toContain('Simon Sinek');
  });

  it('a medallion fixture never impersonates an approved full-image portrait', () => {
    render(<AdvisorSeat seat={seat} medallionSrc={fallback[seat.seatId]} variant="room" />);
    const button = screen.getByTestId('council-seat-simon-sinek');
    expect(button.getAttribute('data-has-portrait')).toBe('false');
    expect(screen.queryByTestId('council-portrait-simon-sinek')).toBeNull();
    const img = button.querySelector('img');
    expect(img?.getAttribute('width')).toBe('36');
    expect(img?.getAttribute('height')).toBe('36');
  });

  it('rejects a swapped seat, foreign URL, unknown celebrity or off-roster image path', () => {
    expect(isApprovedCouncilRoomPortrait('/council/portraits/simon-sinek-room.webp', 'simon-sinek')).toBe(true);
    for (const path of [
      '/council/portraits/steve-harvey-room.webp',
      '/council/portraits/td-jakes-room.webp',
      'https://example.com/simon-sinek-room.webp',
      '/council/portraits/simon-sinek-thumb.webp',
      '/council/portraits/simon-sinek-room.svg',
    ]) {
      expect(isApprovedCouncilRoomPortrait(path, 'simon-sinek')).toBe(false);
    }
    render(
      <AdvisorSeat
        seat={seat}
        medallionSrc="/council/portraits/steve-harvey-room.webp"
        variant="room"
      />,
    );
    expect(screen.getByTestId('council-seat-simon-sinek').getAttribute('data-has-portrait')).toBe('false');
  });

  it('the full (reading) seat retains its existing dense/accessible medallion layout', () => {
    render(
      <AdvisorSeat
        seat={seat}
        medallionSrc="/council/portraits/simon-sinek-room.webp"
        variant="full"
      />,
    );
    const button = screen.getByTestId('council-seat-simon-sinek');
    expect(button.getAttribute('data-has-portrait')).toBe('false');
    expect(button.querySelector('img')?.getAttribute('width')).toBe('44');
    expect(button.textContent).toContain('Simon Sinek');
  });

  it('approved room portraits have full-height styling without shrinking names below 16px', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/council/council-theme.css'), 'utf8');
    expect(css).toContain(".council-stage .council-seat-room[data-has-portrait='true']");
    expect(css).toContain('height: 145px;');
    expect(css).toContain('font-size: var(--council-text-name)');
    expect(css).toContain('width: min(116px, 100%)');
  });
});
