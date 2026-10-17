/**
 * WER-016: active Council session page Start panel integration proof.
 * Unlike the old SessionDetail-only test, this controls the component
 * mounted by /council/[sessionId] and tests the actual Start envelope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CouncilRunStartPanel } from '../../src/components/council/CouncilRunStartPanel';
import type { CouncilStoredSession } from '../../src/lib/council/store';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sessionId = 'sess-wer016-start';
function session(
  state: string = 'DRAFT',
  stateVersion = 4,
): CouncilStoredSession {
  return {
    state: { state, state_version: stateVersion },
  } as unknown as CouncilStoredSession;
}

function fakeResponse(data: unknown, status = 202): Response {
  return new Response(JSON.stringify({
    ok: true,
    data,
    request_id: 'req-real-receipt',
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

const genuineReceipt = {
  session_id: sessionId,
  state: 'QUEUED',
  state_version: 6,
  idempotent_replay: false,
  job_id: 'job-actual-1',
  grant_id: 'grant-authorized-1',
  attempt: 1,
};

describe('active mounted Council run start panel', () => {
  it('is actually embedded in the active /council/[sessionId] page, outside replay', () => {
    const page = readFileSync(resolve('src/app/council/[sessionId]/page.tsx'), 'utf8');
    expect(page).toContain('<CouncilRunStartPanel');
    expect(page).toContain('!replay && detail');
    expect(page).toContain('readStoredCouncilSession(sessionId)');
    expect(page).toContain('accessVia={detail.accessVia}');
    expect(page).toContain('state_version: receipt.state_version');
  });

  it('queues one authorized job and shows only the server receipt, not fake progress', async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn(async () => fakeResponse(genuineReceipt));
    vi.stubGlobal('fetch', fetchStub);
    const onQueued = vi.fn();
    render(<CouncilRunStartPanel
      sessionId={sessionId}
      session={session()}
      accessVia={null}
      onQueued={onQueued}
    />);
    await user.click(screen.getByTestId('mounted-council-start'));
    const status = await screen.findByTestId('mounted-council-start-receipt');
    expect(status.textContent).toContain('job-actual-1');
    expect(status.textContent).toContain('not mean the advisors have finished');
    expect(screen.getByTestId('mounted-council-start-blocked').textContent).toContain('second Start');
    expect(screen.queryByTestId('mounted-council-start')).toBeNull();
    expect(onQueued).toHaveBeenCalledOnce();
    expect(onQueued).toHaveBeenCalledWith(genuineReceipt);
    expect(fetchStub).toHaveBeenCalledOnce();
    const args = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(args[0]).toContain('/api/council/sessions/' + sessionId + '/start');
    expect(args[1].method).toBe('POST');
    const payload = JSON.parse(String(args[1].body));
    expect(payload).toEqual({ expected_version: 4 });
    expect((args[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('refuses an invalid 202 instead of inventing a queued job', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 'ok' })));
    const onQueued = vi.fn();
    render(<CouncilRunStartPanel
      sessionId={sessionId}
      session={session()}
      accessVia={null}
      onQueued={onQueued}
    />);
    await user.click(screen.getByTestId('mounted-council-start'));
    await screen.findByTestId('mounted-council-start-error');
    expect(onQueued).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mounted-council-start-receipt')).toBeNull();
  });

  it('does not expose a Start action for support access or already queued state', () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const a = render(<CouncilRunStartPanel
      sessionId={sessionId} session={session()} accessVia="support" onQueued={vi.fn()} />);
    expect(screen.queryByTestId('mounted-council-start')).toBeNull();
    expect(screen.getByTestId('mounted-council-start-blocked').textContent).toContain('Read-only');
    a.unmount();
    render(<CouncilRunStartPanel
      sessionId={sessionId} session={session('QUEUED')} accessVia={null} onQueued={vi.fn()} />);
    expect(screen.queryByTestId('mounted-council-start')).toBeNull();
    expect(screen.getByTestId('mounted-council-start-blocked').textContent).toContain('already queued');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('surfaces a missing run grant without claiming the run has started', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'RUN_AUTHORIZATION_REQUIRED',
        message: 'No active Council-run grant was resolved for this session.',
        retryable: false,
        action: 'preview_and_approve_grant',
        request_id: 'req-refusal',
      },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })));
    render(<CouncilRunStartPanel
      sessionId={sessionId}
      session={session()}
      accessVia={null}
      onQueued={vi.fn()}
    />);
    await user.click(screen.getByTestId('mounted-council-start'));
    const status = await screen.findByTestId('mounted-council-start-error');
    expect(status.textContent).toContain('RUN_AUTHORIZATION_REQUIRED');
    expect(screen.queryByTestId('mounted-council-start-receipt')).toBeNull();
  });
});
