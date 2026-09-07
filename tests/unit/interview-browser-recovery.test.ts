import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverInterviewAccess, resumePhase, verifiedProgress, interviewDraftScope, INTERVIEW_SIGN_IN_HELP, INTERVIEW_RETRY_HELP } from '../../src/lib/interview/browser-recovery';

const progress = { ok: true, session: {}, resume: {}, structured: {} };
function transport(responses: Response[]) {
  const calls: {url: string; init?: RequestInit}[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init});
    const response = responses.shift();
    assert.ok(response, 'unexpected request');
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}
test('valid browser/Access session ignores stale enrollment and never consumes another ticket', async () => {
  const t = transport([Response.json(progress)]);
  assert.equal(await recoverInterviewAccess('expired-or-used', t.fetcher), null);
  assert.deepEqual(t.calls.map(x => x.url), ['/api/interview/state']);
});
test('new browser redeems private invitation only after authentication refusal', async () => {
  const t = transport([Response.json({}, {status:403}), Response.json({ok:true})]);
  assert.equal(await recoverInterviewAccess('private-ticket', t.fetcher), null);
  assert.equal(t.calls[1].url, '/api/auth/interview-session');
  assert.deepEqual(JSON.parse(String(t.calls[1].init?.body)), {ticket:'private-ticket'});
});
test('expired link without sign-in explains renewal without starting over', async () => {
  const t = transport([Response.json({}, {status:403}), Response.json({}, {status:409})]);
  assert.equal(await recoverInterviewAccess('used', t.fetcher), INTERVIEW_SIGN_IN_HELP);
});
test('temporary or false-green state cannot consume invitation or show empty restart', async () => {
  for (const response of [Response.json({}, {status:503}), Response.json({...progress,ok:false})]) {
    const t = transport([response]);
    assert.equal(await recoverInterviewAccess('unused', t.fetcher), INTERVIEW_RETRY_HELP);
    assert.equal(t.calls.length, 1);
  }
  assert.equal(verifiedProgress({...progress,ok:false}), false);
});
test('saved server gates resume questions, conversation, departments or review correctly', () => {
  const flags = {genuineTranscriptReady:true,decisionCoverageComplete:true,noUnprovenancedDeclines:true};
  assert.equal(resumePhase(4, flags), 'structured');
  assert.equal(resumePhase(null, {...flags,genuineTranscriptReady:false}), 'conversation');
  assert.equal(resumePhase(null, {...flags,decisionCoverageComplete:false}), 'departments');
  assert.equal(resumePhase(null, {...flags,noUnprovenancedDeclines:false}), 'departments');
  assert.equal(resumePhase(null, flags), 'review');
});
test('draft identity includes verified company, installation and interview; no unresolved bucket', () => {
  assert.equal(interviewDraftScope(null),null);
  const a = {companyId:'a',installationId:'one',buildId:'build'};
  assert.notEqual(interviewDraftScope(a),interviewDraftScope({...a,companyId:'b'}));
  assert.notEqual(interviewDraftScope(a),interviewDraftScope({...a,installationId:'two'}));
  assert.notEqual(interviewDraftScope(a),interviewDraftScope({...a,buildId:'new'}));
});
