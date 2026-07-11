/**
 * The Anthology participant token page (SPEC 11.3 / WAVE-PLAN W3.3).
 *
 * The ONE public, self-authenticating page in the deployment. An external
 * co-author lands here from the nudge link their producer sent, holding a
 * single-purpose scoped credential:
 *   • a TOKEN, in the path (`/participant/<token>`) or query (`?t=<token>`), or
 *   • a PIN, with its scope in the query (`?s=<subject>&exp=<epoch>[&g=<gate>]`),
 *     typed on arrival.
 *
 * The page never verifies the credential itself — it hands it to the engine
 * (`gate_engine.py`, the SAME both-door endpoint the producer board uses), which
 * checks the HMAC signature, single-gate scope, expiry, and replay under
 * ANTHOLOGY_GATE_TOKEN_SECRET and refuses foreign / expired / replayed access.
 * Whatever comes back is run through the client-clean serializer before a single
 * byte reaches the browser: no ids, no gate codes, no plumbing, no secrets.
 *
 * It serves ONLY the visitor's currently-open gate: title selection (S3),
 * outline approval (S4), or chapter approve-as-is / request-rewrite (S5/S6).
 */

import { loadGate, type GateCredential } from '../_lib/gate-engine';
import { serializeFailure, serializeGate, PLATFORM_NAME, type ParticipantView } from '../_lib/serialize';
import GateForm, { type FormCredential } from './GateForm';

// A token-scoped page must never be cached or statically rendered.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

type SearchParams = { [key: string]: string | string[] | undefined };

function one(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

interface Resolved {
  view: ParticipantView;
  credential?: FormCredential;
  /** Show the typed-PIN entry form (subject+expiry known, PIN not yet supplied). */
  pinEntry?: { subject: string; exp: string; gate?: string };
}

function resolve(params: { token?: string[] }, searchParams: SearchParams): Resolved {
  // 1. Token credential (path segment wins, else `?t=`).
  const token = params.token?.[0] || one(searchParams.t);
  if (token) {
    const cred: GateCredential = { kind: 'token', token };
    return { view: serializeGate(loadGate(cred)), credential: { kind: 'token', token } };
  }

  // 2. PIN credential — scope carried in the query; the PIN authenticates.
  const subject = one(searchParams.s);
  const exp = one(searchParams.exp);
  const gate = one(searchParams.g);
  const pin = one(searchParams.pin);
  if (subject && exp && pin) {
    const cred: GateCredential = { kind: 'pin', subjectKey: subject, pin, exp, gate };
    return {
      view: serializeGate(loadGate(cred)),
      credential: { kind: 'pin', subject, pin, exp, gate },
    };
  }
  // 2b. Scope present but no PIN yet → ask the visitor to type it.
  if (subject && exp) {
    return { view: { ok: false, heading: '', message: '', retryable: false }, pinEntry: { subject, exp, gate } };
  }

  // 3. No usable credential at all.
  return { view: serializeFailure('invalid') };
}

export default function ParticipantPage({
  params,
  searchParams,
}: {
  params: { token?: string[] };
  searchParams: SearchParams;
}) {
  const resolved = resolve(params, searchParams);

  return (
    <div className="flex min-h-full flex-col">
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-8 sm:px-6">
        <div className="rounded-3xl border border-gray-200 bg-white p-6 shadow-card sm:p-8">
          {resolved.pinEntry ? (
            <PinEntry {...resolved.pinEntry} />
          ) : resolved.view.ok ? (
            <GatePanel view={resolved.view} credential={resolved.credential!} />
          ) : (
            <RefusalPanel heading={resolved.view.heading} message={resolved.view.message} />
          )}
        </div>
        <Footer />
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="flex h-14 items-center justify-center border-b border-gray-200 bg-white px-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-brand-600" aria-hidden="true" />
        <span className="text-[15px] font-semibold tracking-tight text-gray-900">{PLATFORM_NAME}</span>
      </div>
    </header>
  );
}

function GatePanel({
  view,
  credential,
}: {
  view: Extract<ParticipantView, { ok: true }>;
  credential: FormCredential;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[24px] font-bold leading-tight tracking-tight text-gray-900">
          {view.heading}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-gray-600">{view.lede}</p>
      </div>
      <GateForm view={view} credential={credential} />
      {view.validThrough && (
        <p className="text-center text-[12px] text-gray-400">
          This link is valid through {view.validThrough}.
        </p>
      )}
    </div>
  );
}

function RefusalPanel({ heading, message }: { heading: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M10 6.5v4M10 13.5h.01M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h1 className="text-[20px] font-bold text-gray-900">{heading}</h1>
      <p className="max-w-sm text-[15px] leading-relaxed text-gray-600">{message}</p>
    </div>
  );
}

/**
 * No-JS typed-PIN entry. A plain GET form that reloads this same page with the
 * PIN appended to the (already-present) scope, at which point the page verifies
 * it through the engine exactly like the token path.
 */
function PinEntry({ subject, exp, gate }: { subject: string; exp: string; gate?: string }) {
  return (
    <form method="get" action="/participant" className="flex flex-col gap-5">
      <input type="hidden" name="s" value={subject} />
      <input type="hidden" name="exp" value={exp} />
      {gate ? <input type="hidden" name="g" value={gate} /> : null}
      <div>
        <h1 className="text-[24px] font-bold leading-tight tracking-tight text-gray-900">
          Enter your PIN
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-gray-600">
          Type the PIN from your email to continue.
        </p>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[14px] font-medium text-gray-700">PIN</span>
        <input
          name="pin"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          required
          autoComplete="one-time-code"
          placeholder="8-digit PIN"
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-[18px] tracking-[0.3em] text-gray-900 placeholder:tracking-normal placeholder:text-gray-400 shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
      </label>
      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-xl bg-brand-600 px-5 py-3 text-[16px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2"
      >
        Continue
      </button>
    </form>
  );
}

function Footer() {
  return (
    <p className="mt-6 text-center text-[12px] text-gray-400">
      Powered by {PLATFORM_NAME}
    </p>
  );
}
