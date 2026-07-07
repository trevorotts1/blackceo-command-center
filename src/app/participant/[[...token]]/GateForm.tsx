'use client';

/**
 * The interactive gate surface. It renders ONLY the actions the serializer
 * cleared for the visitor's open gate (title selection, outline approval, or
 * chapter approve-as-is / request-rewrite-with-notes) and submits through the
 * `submitGateDecision` server action. It holds the visitor's capability
 * (token, or PIN scope) in hidden fields — the same capability that is already
 * in their URL — and no other state. Nothing here fetches or decodes anything;
 * all authority lives server-side in the engine.
 *
 * Uses only stable React 18.0 hooks (useState + useTransition) and calls the
 * server action imperatively, so it does not depend on the react-dom 18.3
 * `useFormState`/`useFormStatus` hooks being present.
 */

import { useState, useTransition } from 'react';
import { submitGateDecision } from './actions';
import type { ActionDescriptor, ParticipantGateView, SubmitView } from '../_lib/serialize';

/** Hidden capability fields carried back to the action. */
export type FormCredential =
  | { kind: 'token'; token: string }
  | { kind: 'pin'; subject: string; pin: string; exp: string; gate?: string };

function CredentialFields({ credential }: { credential: FormCredential }) {
  if (credential.kind === 'token') {
    return (
      <>
        <input type="hidden" name="cred_kind" value="token" />
        <input type="hidden" name="token" value={credential.token} />
      </>
    );
  }
  return (
    <>
      <input type="hidden" name="cred_kind" value="pin" />
      <input type="hidden" name="subject" value={credential.subject} />
      <input type="hidden" name="pin" value={credential.pin} />
      <input type="hidden" name="exp" value={credential.exp} />
      {credential.gate ? <input type="hidden" name="gate" value={credential.gate} /> : null}
    </>
  );
}

function find(
  actions: ReadonlyArray<ActionDescriptor>,
  action: string
): ActionDescriptor | undefined {
  return actions.find((a) => a.action === action);
}

const inputClass =
  'w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-[16px] text-gray-900 placeholder:text-gray-400 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-300';

const primaryBtn =
  'inline-flex items-center justify-center rounded-xl bg-brand-600 px-5 py-3 text-[16px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const secondaryBtn =
  'inline-flex items-center justify-center rounded-xl border border-gray-300 bg-white px-5 py-3 text-[16px] font-semibold text-gray-700 shadow-sm transition-colors hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-60';

/** A submit button that names its engine action (captured as the form submitter). */
function SubmitButton({
  action,
  label,
  className,
  pending,
}: {
  action: string;
  label: string;
  className: string;
  pending: boolean;
}) {
  return (
    <button type="submit" name="action" value={action} className={className} disabled={pending}>
      {pending ? 'Working…' : label}
    </button>
  );
}

function SuccessPanel({ view }: { view: Extract<SubmitView, { ok: true }> }) {
  return (
    <div role="status" className="rounded-2xl border border-brand-200 bg-brand-50 p-6 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white">
        <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M5 10.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="text-[20px] font-bold text-gray-900">{view.heading}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-gray-600">{view.message}</p>
      <p className="mt-4 text-[13px] text-gray-400">You can close this page.</p>
    </div>
  );
}

export default function GateForm({
  view,
  credential,
}: {
  view: ParticipantGateView;
  credential: FormCredential;
}) {
  const [state, setState] = useState<SubmitView | null>(null);
  const [pending, startTransition] = useTransition();
  const [rewriteMode, setRewriteMode] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const formData = new FormData(form);
    // The clicked submit button's name/value identifies the engine action; the
    // submitter is not auto-included when building FormData from the form.
    if (submitter?.name) formData.set(submitter.name, submitter.value);
    startTransition(async () => {
      const result = await submitGateDecision(null, formData);
      setState(result);
    });
  }

  if (state && state.ok) {
    return <SuccessPanel view={state} />;
  }

  const banner =
    state && !state.ok ? (
      <div
        role="alert"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[14px] text-amber-800"
      >
        <span className="font-semibold">{state.heading}.</span> {state.message}
      </div>
    ) : null;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <CredentialFields credential={credential} />
      {banner}

      {view.kind === 'title' && <TitleFields view={view} pending={pending} />}

      {view.kind === 'outline' && (
        <div className="flex flex-col gap-4">
          <p className="text-[15px] leading-relaxed text-gray-600">
            When you’re happy with your outline, approve it to move on to your draft.
          </p>
          {find(view.actions, 'approve') && (
            <SubmitButton
              action="approve"
              label={find(view.actions, 'approve')!.label}
              className={primaryBtn}
              pending={pending}
            />
          )}
        </div>
      )}

      {view.kind === 'chapter' && (
        <ChapterActions
          view={view}
          rewriteMode={rewriteMode}
          setRewriteMode={setRewriteMode}
          pending={pending}
        />
      )}
    </form>
  );
}

function TitleFields({ view, pending }: { view: ParticipantGateView; pending: boolean }) {
  const save = find(view.actions, 'select');
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] font-medium text-gray-700">Title</span>
        <input
          className={inputClass}
          name="title"
          type="text"
          required
          maxLength={200}
          placeholder="Your chapter title"
          autoComplete="off"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] font-medium text-gray-700">
          Subtitle <span className="font-normal text-gray-400">(optional)</span>
        </span>
        <input
          className={inputClass}
          name="subtitle"
          type="text"
          maxLength={200}
          placeholder="Add a subtitle"
          autoComplete="off"
        />
      </label>
      {save && (
        <SubmitButton action="select" label={save.label} className={primaryBtn} pending={pending} />
      )}
    </div>
  );
}

function ChapterActions({
  view,
  rewriteMode,
  setRewriteMode,
  pending,
}: {
  view: ParticipantGateView;
  rewriteMode: boolean;
  setRewriteMode: (v: boolean) => void;
  pending: boolean;
}) {
  const approve = find(view.actions, 'approve_as_is');
  const rewrite = find(view.actions, 'request_rewrite_with_notes');

  if (rewriteMode && rewrite) {
    return (
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-medium text-gray-700">
            What would you like changed?
          </span>
          <textarea
            className={`${inputClass} min-h-[140px] resize-y`}
            name="notes"
            required
            maxLength={4000}
            placeholder="Describe the changes you’d like — as much or as little detail as you want."
          />
        </label>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <button
            type="button"
            className={secondaryBtn}
            onClick={() => setRewriteMode(false)}
            disabled={pending}
          >
            Back
          </button>
          <SubmitButton
            action="request_rewrite_with_notes"
            label={rewrite.label}
            className={primaryBtn}
            pending={pending}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {approve && (
        <SubmitButton
          action="approve_as_is"
          label={approve.label}
          className={primaryBtn}
          pending={pending}
        />
      )}
      {rewrite && (
        <button
          type="button"
          className={secondaryBtn}
          onClick={() => setRewriteMode(true)}
          disabled={pending}
        >
          {rewrite.label}
        </button>
      )}
    </div>
  );
}
