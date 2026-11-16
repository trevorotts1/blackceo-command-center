import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CallMode from '@/components/operator/CallMode';

beforeEach(() => {
  window.localStorage.clear();
  // jsdom only. Never request a real microphone or open a browser surface.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: vi.fn().mockRejectedValue(new Error('Headless fixture microphone disabled')),
  } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    default: 'fish_audio', providers: [
      { id: 'openai', label: 'OpenAI TTS', available: true },
      { id: 'fish_audio', label: 'Fish Audio', available: false },
      { id: 'browser', label: 'Browser', available: true },
    ],
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

for (const saved of [null, 'fish_audio'] as const) {
  it(`keeps ${saved ? 'saved' : 'server default'} Fish Audio visibly blocked until the user chooses another voice`, async () => {
    if (saved) window.localStorage.setItem('bcc.call.tts.provider', saved);
    render(<CallMode onClose={vi.fn()} />);
    const picker = await screen.findByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('fish_audio'));
    const option = screen.getByRole('option', { name: 'Fish Audio (needs configuration)' }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(screen.getByText(/Your selected Fish Audio voice needs configuration/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.every(call => call[0] === '/api/operator/tts' && call[1]?.method === 'GET')).toBe(true);
    fireEvent.change(picker, { target: { value: 'openai' } });
    await waitFor(() => expect(picker.value).toBe('openai'));
    expect(window.localStorage.getItem('bcc.call.tts.provider')).toBe('openai');
  });
}

for (const metadata of ['http-error', 'empty'] as const) {
  it(`does not start a call or choose browser speech after ${metadata} provider metadata`, async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metadata === 'http-error'
      ? new Response('{}', { status: 502 }) : Response.json({ default: 'fish_audio', providers: [] })));
    render(<CallMode onClose={vi.fn()} />);
    expect(await screen.findByText(/Could not verify voice settings/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
}
