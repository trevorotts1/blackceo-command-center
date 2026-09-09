'use client';

/**
 * src/components/social-theme/ThemeWizard.tsx — F27 step flow shared shell.
 *
 * Owns: step navigation (save immediately on step change — never rely on
 * page-unload delivery), the submit action with its durable receipt, skip
 * this week, and the pause/reminders preference. Step content is passed in
 * as fields so the wizard stays one component across all seven screens.
 *
 * Screens (SPEC mini-app screens):
 *   welcome → theme-and-goal → offer-and-audience → assets-and-accounts →
 *   review-and-submit → progress → history
 */

import { useCallback, useMemo, useState } from 'react';
import { useThemeDraftCore, type ServerDraft } from './useThemeDraft';
import { SaveBadge, ConflictBanner } from './SaveBadge';

export interface WizardState {
  planner_url?: string | null;
  handoff?: {state:string;task_id:string|null;error:string|null;budget_usd?:number|null}|null;
  company_id: string;
  cycle: { id: string; week_start_local: string; timezone: string; state: string };
  session: { id: string; revision: number; status: string; saved_at: string | null; submitted_at: string | null };
  answers: Record<string, string>;
  suggestions: string[];
  history: Array<{ week_start_local: string; state: string }>;
}

export type StepId =
  | 'welcome'
  | 'theme-and-goal'
  | 'offer-and-audience'
  | 'assets-and-accounts'
  | 'review-and-submit'
  | 'progress'
  | 'history';

const STEP_ORDER: StepId[] = [
  'welcome',
  'theme-and-goal',
  'offer-and-audience',
  'assets-and-accounts',
  'review-and-submit',
];

const STEP_LABEL: Record<StepId, string> = {
  welcome: 'Welcome',
  'theme-and-goal': 'Theme & goal',
  'offer-and-audience': 'Offer & audience',
  'assets-and-accounts': 'Assets & accounts',
  'review-and-submit': 'Review & submit',
  progress: 'Progress',
  history: 'History',
};

export interface Receipt {
  receipt_id: string;
  cycle_id: string;
  revision: number;
  submitted_at: string;
}

export function ThemeWizard({ initial }: { initial: WizardState }) {
  const [step, setStep] = useState<StepId>(
    initial.session.status === 'submitted' ? 'progress' : 'welcome',
  );
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);

  const submitted = initial.session.status === 'submitted';

  const wizard = useThemeDraftCore(initial.answers, initial.session.revision, {
    companyId: initial.company_id,
    sessionId: initial.session.id,
    onConflict: (server: ServerDraft) => { /* surfaced via wizard.conflict banner */ },
  });

  const fields = wizard.answers;
  const goto = useCallback((next: StepId) => {
    void wizard.saveNow(); // save immediately on step navigation
    setStep(next);
  }, [wizard]);

  const setField = useCallback(
    (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      wizard.onChange(field, e.target.value),
    [wizard],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const savedRevision = await wizard.saveNow();
      if (savedRevision === null) {
        setSubmitError("Your draft needs attention. Resolve the save issue before submitting.");
        return;
      }
      const res = await fetch('/api/social-theme/submit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: savedRevision }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { server?: ServerDraft };
        if (body.server) wizard.applyServerAnswers(body.server);
        setSubmitError('Your draft changed elsewhere. Review the merged answers and submit again.');
        return;
      }
      if (!res.ok) {
        setSubmitError('Submit failed — your answers are saved. Retry in a moment.');
        return;
      }
      const body = (await res.json()) as { receipt: Receipt; already_submitted: boolean };
      setReceipt(body.receipt);
      setStep('progress');
    } catch {
      setSubmitError('Submit failed — your answers are saved. Retry when back online.');
    } finally {
      setSubmitting(false);
    }
  }, [wizard]);

  const skipWeek = useCallback(async () => {
    setSkipError(null);
    try {
      const res = await fetch('/api/social-theme/skip', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setSkipError('Could not skip this week — try again.');
        return;
      }
      setSkipped(true);
      setStep('history');
    } catch {
      setSkipError('Could not skip this week — try again.');
    }
  }, []);

  const togglePause = useCallback(async () => {
    try {
      const next = !(paused ?? false);
      const res = await fetch('/api/social-theme/preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reminders_paused: next }),
      });
      if (res.ok) setPaused(next);
    } catch { /* badge-free setting; retry on next toggle */ }
  }, [paused]);

  const weekLabel = useMemo(
    () => `Week of ${initial.cycle.week_start_local}`,
    [initial.cycle.week_start_local],
  );

  if (step === 'history') {
    return (
      <main style={page}>
        <h1 style={h1}>History</h1>
        {skipped && <p data-testid="skip-confirmation" style={{ color: '#16a34a' }}>{weekLabel} skipped. Next week&apos;s invitation still arrives as usual.</p>}
        {skipError && <p style={{ color: '#dc2626' }}>{skipError}</p>}
        <ul style={{ paddingLeft: '1.1rem', lineHeight: 1.7 }}>
          {initial.history.map((h) => (
            <li key={h.week_start_local}>
              Week of {h.week_start_local} — <strong>{h.state}</strong>
            </li>
          ))}
        </ul>
        <p style={{ color: '#666', fontSize: '0.85rem' }}>
          Questions and answers for previous weeks can be exported from your Command Center records.
        </p>
        {paused === null && (
          <button type="button" onClick={togglePause} style={btn}>
            Pause weekly reminders
          </button>
        )}
        {paused !== null && (
          <button type="button" onClick={togglePause} style={btn}>
            {paused ? 'Resume weekly reminders' : 'Pause weekly reminders'}
          </button>
        )}
      </main>
    );
  }

  if (step === 'progress') {
    return (
      <main style={page}>
        <h1 style={h1}>{weekLabel} — submitted</h1>
        {receipt ? (
          <p data-testid="submit-receipt" style={{ color: '#16a34a' }}>
            Receipt {receipt.receipt_id} · revision {receipt.revision} · {new Date(receipt.submitted_at).toLocaleString()}
          </p>
        ) : (
          <p style={{ color: '#16a34a' }}>
            Your answers were submitted{initial.session.submitted_at ? ` on ${new Date(initial.session.submitted_at).toLocaleString()}` : ''}. Your production request is saved.
          </p>
        )}
        <p style={{ color: '#555' }}>
          {initial.handoff?.error ? 'Your answers are saved, but the planner handoff needs attention.' : initial.handoff?.state === 'awaiting_budget' ? 'Your plan is on the board and needs an approved production budget before work can start.' : initial.handoff?.state === 'done' ? 'Your plan is complete and ready to review.' : initial.handoff?.state === 'in_progress' ? 'Your plan is being prepared. Open your planner to check progress.' : initial.handoff?.task_id ? 'Your plan is on the board. Production has not been confirmed complete.' : 'Your answers are saved. The planner handoff is pending.'}
        </p>
        {initial.handoff?.budget_usd != null && <p>Approved production limit: ${initial.handoff.budget_usd} for this week.</p>}
        <button type="button" onClick={() => window.location.reload()} style={btn}>Refresh status</button>
        {initial.planner_url && <p><a href={initial.planner_url} target="_blank" rel="noopener noreferrer">Open your Google Sheets planner</a></p>}
        {/* F38 player reuse: the preview link (delivered in your invitation
            conversation) opens the company-bound HTML video player at
            /social/media/{assetId} — same component family, same session
            rules. No duplicate player is embedded here. */}
        <button type="button" onClick={() => goto('history')} style={btn}>See history & settings</button>
      </main>
    );
  }

  const idx = STEP_ORDER.indexOf(step);

  return (
    <main style={page}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={h1}>{weekLabel}</h1>
        <SaveBadge state={wizard.saveState} />
      </header>
      <nav aria-label="Progress" style={{ display: 'flex', gap: '0.4rem', margin: '0.6rem 0 1rem', flexWrap: 'wrap' }}>
        {STEP_ORDER.map((s, i) => (
          <span key={s} style={{
            fontSize: '0.75rem',
            padding: '0.15rem 0.5rem',
            borderRadius: 99,
            border: `1px solid ${i <= idx ? '#16a34a' : '#ddd'}`,
            color: i <= idx ? '#16a34a' : '#999',
          }}>
            {i + 1}. {STEP_LABEL[s]}
          </span>
        ))}
      </nav>

      <ConflictBanner
        conflict={wizard.conflict ? { revision: wizard.conflict.revision, answers: wizard.conflict.answers } : null}
        onUseServer={() => wizard.conflict && wizard.applyServerAnswers(wizard.conflict)}
        onKeepMine={() => wizard.conflict && void wizard.keepMineAndResubmit(fields)}
      />

      {step === 'welcome' && (
        <section data-testid="step-welcome">
          <h2>Welcome back</h2>
          <p>
            This is your private weekly social plan. Saved progress: revision {initial.session.revision}
            {initial.session.saved_at ? `, last saved ${new Date(initial.session.saved_at).toLocaleString()}` : ''}.
          </p>
          <p style={{ color: '#555' }}>
            Models and mode for this week: standard production with your saved settings — change any time under settings after submitting.
          </p>
          <button type="button" onClick={() => goto('theme-and-goal')} style={btnPrimary}>
            {initial.session.revision > 0 ? 'Resume where you left off' : 'Start this week'}
          </button>
          <button type="button" onClick={() => goto('history')} style={btn}>History & settings</button>
        </section>
      )}

      {step === 'theme-and-goal' && (
        <section data-testid="step-theme">
          <h2>Theme and goal</h2>
          <label style={label} htmlFor="st-theme">This week&apos;s theme</label>
          <input id="st-theme" data-testid="theme-input" style={input} value={fields['theme'] || ''} onChange={setField('theme')} onBlur={wizard.onBlur} placeholder="Type a theme, or pick a suggestion" />
          {initial.suggestions.length > 0 && (
            <div style={{ margin: '0.5rem 0' }}>
              <span style={{ color: '#666', fontSize: '0.85rem' }}>Suggestions from your approved history:</span>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                {initial.suggestions.map((s) => (
                  <button key={s} type="button" style={chip} onClick={() => wizard.onChange('theme', s)}>…{s.slice(0, 40)}</button>
                ))}
              </div>
            </div>
          )}
          <button type="button" onClick={() => wizard.onChange('theme', '__help_me_choose__')} style={btn}>
            Help me choose
          </button>
          <label style={label} htmlFor="st-goal">Business goal</label>
          <select id="st-goal" data-testid="goal-select" style={input} value={fields['goal'] || ''} onChange={(e) => wizard.onChange('goal', e.target.value)} onBlur={wizard.onBlur}>
            <option value="">Select a goal…</option>
            <option value="leads">Generate leads</option>
            <option value="awareness">Build awareness</option>
            <option value="authority">Show authority</option>
            <option value="nurture"> Nurture existing clients</option>
            <option value="promo">Promote an offer</option>
          </select>
          <div style={navRow}>
            <button type="button" onClick={() => goto('welcome')} style={btn}>Back</button>
            <button type="button" onClick={() => goto('offer-and-audience')} style={btnPrimary}>Next</button>
          </div>
        </section>
      )}

      {step === 'offer-and-audience' && (
        <section data-testid="step-offer">
          <h2>Offer and audience</h2>
          <label style={label} htmlFor="st-offer">Promotion / offer details and dates</label>
          <input id="st-offer" data-testid="offer-input" style={input} value={fields['offer'] || ''} onChange={setField('offer')} onBlur={wizard.onBlur} placeholder="What are you promoting, and until when?" />
          <label style={label} htmlFor="st-cta">Call to action</label>
          <input id="st-cta" data-testid="cta-input" style={input} value={fields['cta'] || ''} onChange={setField('cta')} onBlur={wizard.onBlur} placeholder="e.g. Book a free strategy call" />
          <label style={label} htmlFor="st-audience">Audience</label>
          <input id="st-audience" data-testid="audience-input" style={input} value={fields['audience'] || ''} onChange={setField('audience')} onBlur={wizard.onBlur} placeholder="Who is this week for?" />
          <label style={label} htmlFor="st-tone">Tone / voice</label>
          <input id="st-tone" data-testid="tone-input" style={input} value={fields['tone'] || ''} onChange={setField('tone')} onBlur={wizard.onBlur} placeholder="e.g. warm, direct, expert" />
          <div style={navRow}>
            <button type="button" onClick={() => goto('theme-and-goal')} style={btn}>Back</button>
            <button type="button" onClick={() => goto('assets-and-accounts')} style={btnPrimary}>Next</button>
          </div>
        </section>
      )}

      {step === 'assets-and-accounts' && (
        <section data-testid="step-assets">
          <h2>Assets and accounts</h2>
          <label style={label} htmlFor="st-assets">Optional references (links or notes)</label>
          <textarea id="st-assets" data-testid="assets-input" style={{ ...input, minHeight: 90 }} value={fields['assets'] || ''} onChange={setField('assets')} onBlur={wizard.onBlur} placeholder="Brand refs, product shots, anything we should reuse" />
          <p style={{ color: '#555', fontSize: '0.9rem' }}>
            Connected channels show their real state (ready / reconnect / excluded) in your weekly video link and on the board. Any missing or expired platform leaves every healthy account available — nothing stalls on one account.
          </p>
          <div style={navRow}>
            <button type="button" onClick={() => goto('offer-and-audience')} style={btn}>Back</button>
            <button type="button" onClick={() => goto('review-and-submit')} style={btnPrimary}>Next</button>
          </div>
        </section>
      )}

      {step === 'review-and-submit' && (
        <section data-testid="step-review">
          <h2>Review and submit</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '9rem 1fr', rowGap: '0.4rem' }}>
            {[
              ['Theme', fields['theme']],
              ['Goal', fields['goal']],
              ['Offer', fields['offer']],
              ['CTA', fields['cta']],
              ['Audience', fields['audience']],
              ['Tone', fields['tone']],
              ['Assets', fields['assets']],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: '#666' }}>{k}</dt>
                <dd style={{ margin: 0 }}>{v ? String(v) : <em style={{ color: '#999' }}>not set</em>}</dd>
              </div>
            ))}
          </dl>
          <p style={{ color: '#555', fontSize: '0.9rem' }}>
            Destinations: your enabled connected accounts · approval: client approves each revision · estimated scope: one weekly plan.
          </p>
          {submitError && <p style={{ color: '#dc2626' }}>{submitError}</p>}
          <div style={navRow}>
            <button type="button" onClick={() => goto('assets-and-accounts')} style={btn}>Back</button>
            <button type="button" data-testid="submit-button" onClick={submit} disabled={submitting || submitted} style={btnPrimary}>
              {submitted ? 'Submitted' : submitting ? 'Submitting…' : 'Submit this week'}
            </button>
            <button type="button" data-testid="skip-button" onClick={skipWeek} style={btn}>Skip this week</button>
          </div>
        </section>
      )}
    </main>
  );
}

/* Shared inline styles — the mini app is a compact branded surface. */
const page: React.CSSProperties = { maxWidth: 720, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' };
const h1: React.CSSProperties = { fontSize: '1.15rem', fontWeight: 600 };
const label: React.CSSProperties = { display: 'block', margin: '0.9rem 0 0.25rem', fontWeight: 500, fontSize: '0.95rem' };
const input: React.CSSProperties = { width: '100%', padding: '0.5rem 0.6rem', borderRadius: 6, border: '1px solid #ccc', fontSize: '0.95rem', boxSizing: 'border-box' };
const navRow: React.CSSProperties = { display: 'flex', gap: '0.75rem', marginTop: '1.25rem' };
const btn: React.CSSProperties = { padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { padding: '0.5rem 1.1rem', borderRadius: 6, border: '1px solid #16a34a', background: '#16a34a', color: '#fff', cursor: 'pointer' };
const chip: React.CSSProperties = { padding: '0.3rem 0.7rem', borderRadius: 99, border: '1px solid #ccc', background: '#f9fafb', cursor: 'pointer', fontSize: '0.85rem' };