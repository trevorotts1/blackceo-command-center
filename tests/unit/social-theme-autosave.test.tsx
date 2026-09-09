// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useThemeDraftCore } from '@/components/social-theme/useThemeDraft';
beforeEach(() => { const values = new Map<string,string>(); vi.stubGlobal('localStorage', { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => values.set(key,value), removeItem: (key:string) => values.delete(key), clear: () => values.clear() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = { companyId: 'test-company', sessionId: 'test-session', debounceMs: 60000 };
describe('weekly theme save ordering', () => {
  it('serializes overlapping blur saves and returns the latest revision', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { complete = r; }))
      .mockResolvedValueOnce(Response.json({ revision: 2, saved_at: 'now' }));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useThemeDraftCore({}, 0, options));
    act(() => result.current.onChange('theme', 'first'));
    let first!: Promise<number | null>;
    await act(async () => { first = result.current.saveNow(); await Promise.resolve(); });
    act(() => result.current.onChange('theme', 'newer edit'));
    let second!: Promise<number | null>;
    await act(async () => { second = result.current.saveNow(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    let revision;
    await act(async () => { complete(Response.json({ revision: 1, saved_at: 'now' })); await first; revision = await second; });
    expect(revision).toBe(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ answers: { theme: 'newer edit' }, expected_revision: 1 });
    expect(result.current.conflict).toBeNull();
    expect(result.current.answers.theme).toBe('newer edit');
    expect(result.current.saveState).toBe('saved');
  });
  it('preserves genuine conflicts and blocks further autosave until resolved', async () => {
    const server = { revision: 4, answers: { theme: 'other device' }, saved_at: 'now' };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ server }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useThemeDraftCore({}, 0, options));
    act(() => result.current.onChange('theme', 'my edit'));
    await act(async () => { expect(await result.current.saveNow()).toBeNull(); });
    await act(async () => { expect(await result.current.saveNow()).toBeNull(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.answers.theme).toBe('my edit');
    expect(result.current.conflict).toEqual(server);
    act(() => result.current.applyServerAnswers(server));
    await act(async () => { expect(await result.current.saveNow()).toBe(4); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps failed saves available for an explicit retry', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ revision: 1 }));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useThemeDraftCore({}, 0, options));
    act(() => result.current.onChange('theme', 'retain me'));
    await act(async () => { expect(await result.current.saveNow()).toBeNull(); });
    expect(result.current.saveState).toBe('retry');
    await act(async () => { expect(await result.current.saveNow()).toBe(1); });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).answers.theme).toBe('retain me');
  });
});
