'use client';

/**
 * DepartmentBoard — the Phase-5.5 flagship of the AI Workforce Interview (P2-5).
 *
 * The visual board that replaces the old "send 29 departments as ONE long
 * Telegram message" hack. It renders one <DeptCard/> per LIVE canonical
 * department and lets the owner keep, skip, or defer each one — then lights a
 * single "every department decided" badge that mirrors the exact build-side
 * gates the enforcer uses, so the Build button can never arm on an unfinished
 * board.
 *
 * ── Where the data comes from (files are the single source of truth) ─────────
 *   • GET /api/interview/canonical-departments → the LIVE floor set
 *     (mandatory + universal-primary-for-your-industry). The count is NEVER
 *     hardcoded — 28 vs 29 is a naming-map version detail; the board renders
 *     exactly what the script returns at runtime. A 503 (naming map briefly
 *     unavailable) degrades to a gentle retry instead of a crash.
 *   • GET /api/interview/state → the authoritative coverage + gate flags
 *     (decisionCoverage.{covered,missing,declined,rejections} and the three
 *     UI gate flags). Custom additions are passed back on this call so coverage
 *     reflects them.
 *
 * ── The ONLY writer ──────────────────────────────────────────────────────────
 * Every YES / NO / LATER press POSTs /api/interview/decision, which presses the
 * exact same record-dept-decision.sh button the Telegram agent presses. This
 * board never hand-writes a decision and never touches the state file directly;
 * a NO therefore becomes a provenanced, HONORED decline (shows "Skipped", is not
 * built downstream), never an un-provenanced rejection.
 *
 * ── Completion (client mirror of gates #3 + #8) ──────────────────────────────
 * The "board complete" badge lights ONLY when the server reports
 * flags.decisionCoverageComplete AND flags.noUnprovenancedDeclines — i.e. every
 * expected department carries a provenanced decision AND there are zero
 * un-provenanced declines. It is driven by SERVER truth, never by local
 * optimistic state, so it can never report complete while any expected dept is
 * undecided. `onCoverageChange` relays that boolean up so the Build button (in
 * InterviewClient / ReviewScreen) can arm.
 *
 * ── Custom departments (opt-out model) ───────────────────────────────────────
 * The recorder only accepts canonical ids, so owner-added departments are KEPT
 * by default and passed as implicit-YES customs on /state (the seam treats them
 * as covered-without-a-write and they don't block completion). "Opt out" simply
 * removes the custom. Adding one that overlaps an existing department raises a
 * merge/keep prompt before it's added.
 *
 * This file imports NOTHING from the Node-only seam — it talks only to the API
 * routes and mirrors their JSON with local types, staying a clean client bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Loader2,
  RefreshCw,
  Plus,
  X,
  GitMerge,
  PartyPopper,
  ShieldCheck,
  Building2,
  AlertTriangle,
} from 'lucide-react';
import {
  iv,
  ivcx,
  ivStaggerParent,
  ivScreenVariants,
} from './interview-theme';
import DeptCard, { type DeptVerb } from './DeptCard';

/* -------------------------------------------------------------------------- */
/* JSON shapes (mirror the API routes; no Node import leaks into the bundle)   */
/* -------------------------------------------------------------------------- */

interface CanonicalEntry {
  id: string;
  display_name: string;
  one_liner: string;
  pack?: string;
}

interface CanonicalDepartments {
  source: string;
  naming_map_version: string;
  mandatory_count: number;
  mandatory: CanonicalEntry[];
  universal_primary_count: number;
  universal_primary_vertical: CanonicalEntry[];
  floor: number;
}

interface DecisionCoverage {
  complete: boolean;
  expected: string[];
  covered: string[];
  missing: string[];
  declined: string[];
  rejections: string[];
}

interface GateFlags {
  genuineTranscriptReady: boolean;
  decisionCoverageComplete: boolean;
  noUnprovenancedDeclines: boolean;
}

interface StateResponse {
  ok: boolean;
  decisionCoverage: DecisionCoverage;
  flags: GateFlags;
}

/** An owner-added department (kept by default; opt-out to remove). */
interface CustomDept {
  id: string;
  name: string;
  oneLiner: string;
}

/** A pending "this overlaps an existing department" decision. */
interface MergePrompt {
  name: string;
  matchName: string;
}

export interface DepartmentBoardProps {
  /** Pin decisions to an existing interview session; else the seam resolves one. */
  sessionId?: string;
  /** Relay board completeness (gates #3 ∧ #8) up so the Build button can arm. */
  onCoverageChange?: (complete: boolean) => void;
  /** Skip the initial auto-load (tests / storybook). */
  autoLoad?: boolean;
  className?: string;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Mirror the enforcer's `_norm`: strip non-alphanumerics + lowercase. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Slugify an owner-typed name into a stable custom id. */
function slugId(s: string): string {
  const slug = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `custom-${slug}` : `custom-${Date.now()}`;
}

/** Decorative emoji only — the id set (never this map) is the source of truth. */
const DEPT_EMOJI: Record<string, string> = {
  marketing: '📣',
  sales: '🤝',
  finance: '💰',
  accounting: '📒',
  operations: '⚙️',
  'customer-service': '🎧',
  'customer-support': '🎧',
  support: '🎧',
  hr: '👥',
  'human-resources': '👥',
  people: '👥',
  legal: '⚖️',
  it: '🖥️',
  product: '🧩',
  engineering: '🛠️',
  design: '🎨',
  research: '🔬',
  logistics: '🚚',
  procurement: '🛒',
  'supply-chain': '🔗',
  admin: '🗂️',
  administration: '🗂️',
  executive: '🧭',
  strategy: '🧭',
  data: '📊',
  analytics: '📊',
  content: '✍️',
  social: '📱',
  'social-media': '📱',
  pr: '📰',
  'public-relations': '📰',
  partnerships: '🤝',
  recruiting: '🧲',
  training: '🎓',
  compliance: '✅',
  security: '🛡️',
  facilities: '🏢',
  events: '🎪',
  community: '🌐',
  success: '🌟',
  'customer-success': '🌟',
  fulfillment: '📦',
  inventory: '📦',
};

function emojiFor(id: string): string {
  const key = id.toLowerCase().replace(/_/g, '-');
  return DEPT_EMOJI[key] ?? DEPT_EMOJI[norm(id)] ?? '🏛️';
}

const ZERO_COVERAGE: DecisionCoverage = {
  complete: false,
  expected: [],
  covered: [],
  missing: [],
  declined: [],
  rejections: [],
};

const ZERO_FLAGS: GateFlags = {
  genuineTranscriptReady: false,
  decisionCoverageComplete: false,
  noUnprovenancedDeclines: false,
};

/* -------------------------------------------------------------------------- */
/* component                                                                   */
/* -------------------------------------------------------------------------- */

export default function DepartmentBoard({
  sessionId,
  onCoverageChange,
  autoLoad = true,
  className,
}: DepartmentBoardProps) {
  // Live canonical catalog (never hardcoded).
  const [catalog, setCatalog] = useState<CanonicalDepartments | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Server-authoritative coverage + gate flags.
  const [coverage, setCoverage] = useState<DecisionCoverage>(ZERO_COVERAGE);
  const [flags, setFlags] = useState<GateFlags>(ZERO_FLAGS);

  // Optimistic per-dept verbs (server confirms/overrides on the next /state read).
  const [localDecisions, setLocalDecisions] = useState<Record<string, DeptVerb>>({});

  // Owner-added departments (kept by default; passed to /state as implicit-YES).
  const [customs, setCustoms] = useState<CustomDept[]>([]);

  // Per-card write state.
  const [busyDept, setBusyDept] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  // Add-a-department UI.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [mergePrompt, setMergePrompt] = useState<MergePrompt | null>(null);

  // Keep the latest custom-id lists for the /state query without re-creating
  // loadState on every custom change.
  const customsRef = useRef<CustomDept[]>([]);
  customsRef.current = customs;

  /* ---- normalized lookups ---- */

  const declinedSet = useMemo(() => new Set(coverage.declined.map(norm)), [coverage.declined]);
  const coveredSet = useMemo(() => new Set(coverage.covered.map(norm)), [coverage.covered]);
  const rejectionSet = useMemo(() => new Set(coverage.rejections.map(norm)), [coverage.rejections]);

  /* ---- canonical catalog ---- */

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch('/api/interview/canonical-departments', { cache: 'no-store' });
      if (res.status === 503) {
        setCatalogError(
          'We’re loading your departments — this can take a moment. Please try again.',
        );
        return;
      }
      if (!res.ok) {
        setCatalogError('We couldn’t load your departments just yet. Please try again.');
        return;
      }
      const data = (await res.json()) as CanonicalDepartments;
      setCatalog(data);
    } catch {
      setCatalogError('Network hiccup loading your departments. Please try again.');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  /* ---- server coverage + gate flags (includes custom ids) ---- */

  const loadState = useCallback(async () => {
    const custom = customsRef.current;
    const params = new URLSearchParams();
    // Customs are kept-by-default → passed as implicit-YES so coverage reflects
    // them without requiring a write the recorder would reject (unknown id).
    if (custom.length > 0) {
      params.set('implicitYesCustomIds', custom.map((c) => c.id).join(','));
    }
    const qs = params.toString();
    try {
      const res = await fetch(`/api/interview/state${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
      const data = (await res.json()) as StateResponse;
      setCoverage(data.decisionCoverage ?? ZERO_COVERAGE);
      setFlags(data.flags ?? ZERO_FLAGS);
    } catch {
      // Fail-closed: keep the last known coverage; the complete badge stays honest.
    }
  }, []);

  /* ---- initial + custom-change loads ---- */

  useEffect(() => {
    if (!autoLoad) return;
    void loadCatalog();
    void loadState();
  }, [autoLoad, loadCatalog, loadState]);

  // Re-read coverage whenever the custom set changes (its ids alter the query).
  const customKey = customs.map((c) => c.id).join(',');
  useEffect(() => {
    if (!autoLoad) return;
    void loadState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customKey]);

  /* ---- board completeness = client mirror of gates #3 ∧ #8 ---- */

  const boardComplete = flags.decisionCoverageComplete && flags.noUnprovenancedDeclines;

  // Relay completeness up (Build button). Emitted only on real change.
  const lastEmitted = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastEmitted.current !== boardComplete) {
      lastEmitted.current = boardComplete;
      onCoverageChange?.(boardComplete);
    }
  }, [boardComplete, onCoverageChange]);

  /* ---- record a YES / NO / LATER (the ONLY sanctioned writer) ---- */

  const decide = useCallback(
    async (id: string, verb: DeptVerb) => {
      if (busyDept) return;
      setBusyDept(id);
      setCardErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      // Optimistic — reconciled by the /state read below.
      setLocalDecisions((prev) => ({ ...prev, [id]: verb }));
      try {
        const res = await fetch('/api/interview/decision', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dept: id, decision: verb, sessionId: sessionId ?? undefined }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          // Roll back the optimistic verb; surface a per-card message.
          setLocalDecisions((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setCardErrors((prev) => ({
            ...prev,
            [id]: data.message ?? 'That didn’t save — please try again.',
          }));
          return;
        }
      } catch {
        setLocalDecisions((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setCardErrors((prev) => ({ ...prev, [id]: 'Network error — please try again.' }));
        return;
      } finally {
        setBusyDept(null);
      }
      // Re-read server truth so the coverage badge + complete flag reflect the
      // authoritative state, never the optimistic guess.
      await loadState();
    },
    [busyDept, loadState, sessionId],
  );

  /* ---- add / merge / remove a custom department ---- */

  const existingNames = useMemo(() => {
    const names = new Map<string, string>(); // norm → display
    for (const d of catalog?.mandatory ?? []) names.set(norm(d.display_name), d.display_name);
    for (const d of catalog?.universal_primary_vertical ?? [])
      names.set(norm(d.display_name), d.display_name);
    for (const d of catalog?.mandatory ?? []) names.set(norm(d.id), d.display_name);
    for (const d of catalog?.universal_primary_vertical ?? [])
      names.set(norm(d.id), d.display_name);
    for (const c of customs) names.set(norm(c.name), c.name);
    return names;
  }, [catalog, customs]);

  const commitCustom = useCallback((name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const id = slugId(clean);
    setCustoms((prev) =>
      prev.some((c) => c.id === id)
        ? prev
        : [...prev, { id, name: clean, oneLiner: 'A department specific to your business.' }],
    );
    setNewName('');
    setAdding(false);
    setMergePrompt(null);
  }, []);

  const tryAddCustom = useCallback(() => {
    const clean = newName.trim();
    if (!clean) return;
    const collision = existingNames.get(norm(clean));
    if (collision) {
      // Raise the merge/keep prompt instead of silently adding a near-duplicate.
      setMergePrompt({ name: clean, matchName: collision });
      return;
    }
    commitCustom(clean);
  }, [newName, existingNames, commitCustom]);

  const removeCustom = useCallback((id: string) => {
    setCustoms((prev) => prev.filter((c) => c.id !== id));
  }, []);

  /* ---- per-card status resolution (server truth first) ---- */

  const verbFor = useCallback(
    (id: string): DeptVerb | null => {
      const key = norm(id);
      // Server-honored decline wins.
      if (declinedSet.has(key)) return 'no';
      // Optimistic (just-clicked) verb shows immediately.
      const local = localDecisions[id];
      if (local) return local;
      // Covered-but-not-declined and no local verb → a kept "yes".
      if (coveredSet.has(key)) return 'yes';
      return null;
    },
    [declinedSet, coveredSet, localDecisions],
  );

  /* ---- derived counts (never a hardcoded total) ---- */

  const expectedCount = coverage.expected.length;
  const decidedCount = coverage.covered.length;
  const remaining = Math.max(0, expectedCount - decidedCount);

  /* ---- renders ---- */

  if (catalogLoading && !catalog) {
    return (
      <div className={ivcx(iv.dark, className)}>
        <div className={iv.stage} style={{ alignItems: 'center' }}>
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
          <p className={iv.lede}>Loading your departments…</p>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className={ivcx(iv.dark, className)}>
        <div className={iv.stage} style={{ alignItems: 'center', textAlign: 'center' }}>
          <AlertTriangle className="h-7 w-7" aria-hidden style={{ color: '#F0B429' }} />
          <p className={iv.lede}>{catalogError ?? 'We couldn’t load your departments.'}</p>
          <button type="button" className={iv.btnPrimary} onClick={() => void loadCatalog()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </button>
        </div>
      </div>
    );
  }

  const mandatory = catalog.mandatory ?? [];
  const recommended = catalog.universal_primary_vertical ?? [];

  return (
    <div className={ivcx(iv.dark, className)}>
      <div className={iv.stage} style={{ maxWidth: '68rem' }}>
        {/* ── header + completeness badge ─────────────────────────────────── */}
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <p className={iv.eyebrow}>Your departments</p>
            <h1 className={iv.question} style={{ fontSize: 'clamp(1.6rem, 1.1rem + 2vw, 2.4rem)' }}>
              Which departments should we build?
            </h1>
            <p className={iv.lede} style={{ marginTop: '0.5rem' }}>
              Keep the ones you want, skip the ones you don&apos;t, and add anything unique to your
              business. {decidedCount} of {expectedCount} decided
              {remaining > 0 ? ` — ${remaining} to go.` : '.'}
            </p>
          </div>
          <CompleteBadge complete={boardComplete} remaining={remaining} />
        </header>

        {/* ── un-provenanced-decline warning (gate #8 mirror) ─────────────── */}
        {coverage.rejections.length > 0 && (
          <div
            role="alert"
            className={iv.card}
            style={{ borderColor: '#8a6d1f', display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}
          >
            <AlertTriangle className="h-5 w-5" aria-hidden style={{ color: '#F0B429', flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--iv-ink-soft)' }}>
              A few departments were skipped without a clear yes or no. Give each a fresh choice below
              so we know exactly what to build.
            </p>
          </div>
        )}

        {/* ── core (mandatory) departments ────────────────────────────────── */}
        <Section title="Core departments" subtitle="Every company runs on these.">
          <CardGrid>
            {mandatory.map((d) => (
              <DeptCard
                key={d.id}
                id={d.id}
                name={d.display_name}
                oneLiner={d.one_liner}
                emoji={emojiFor(d.id)}
                kind="core"
                decision={verbFor(d.id)}
                covered={coveredSet.has(norm(d.id)) || declinedSet.has(norm(d.id))}
                needsReconfirm={rejectionSet.has(norm(d.id))}
                busy={busyDept === d.id}
                error={cardErrors[d.id] ?? null}
                disabled={busyDept !== null && busyDept !== d.id}
                onDecide={(verb) => void decide(d.id, verb)}
              />
            ))}
          </CardGrid>
        </Section>

        {/* ── recommended (universal-primary) departments ─────────────────── */}
        {recommended.length > 0 && (
          <Section
            title="Recommended for your industry"
            subtitle="A great fit for what you do — keep them or opt out."
          >
            <CardGrid>
              {recommended.map((d) => (
                <DeptCard
                  key={d.id}
                  id={d.id}
                  name={d.display_name}
                  oneLiner={d.one_liner}
                  emoji={emojiFor(d.id)}
                  kind="recommended"
                  decision={verbFor(d.id)}
                  covered={coveredSet.has(norm(d.id)) || declinedSet.has(norm(d.id))}
                  needsReconfirm={rejectionSet.has(norm(d.id))}
                  busy={busyDept === d.id}
                  error={cardErrors[d.id] ?? null}
                  disabled={busyDept !== null && busyDept !== d.id}
                  onDecide={(verb) => void decide(d.id, verb)}
                />
              ))}
            </CardGrid>
          </Section>
        )}

        {/* ── your own additions (custom, opt-out model) ──────────────────── */}
        <Section
          title="Your own additions"
          subtitle="Anything unique to your business we haven’t listed."
        >
          <CardGrid>
            <AnimatePresence>
              {customs.map((c) => (
                <DeptCard
                  key={c.id}
                  id={c.id}
                  name={c.name}
                  oneLiner={c.oneLiner}
                  emoji={emojiFor(c.id)}
                  kind="custom"
                  decision="yes"
                  covered
                  busy={false}
                  disabled={busyDept !== null}
                  onRemove={() => removeCustom(c.id)}
                />
              ))}
            </AnimatePresence>
            <AddDepartmentCard
              adding={adding}
              value={newName}
              onOpen={() => setAdding(true)}
              onCancel={() => {
                setAdding(false);
                setNewName('');
              }}
              onChange={setNewName}
              onSubmit={tryAddCustom}
              disabled={busyDept !== null}
            />
          </CardGrid>
        </Section>
      </div>

      {/* ── merge / keep prompt (mergeDecisions) ──────────────────────────── */}
      <AnimatePresence>
        {mergePrompt && (
          <MergeKeepDialog
            prompt={mergePrompt}
            onMerge={() => setMergePrompt(null)}
            onKeep={() => commitCustom(mergePrompt.name)}
            onCancel={() => setMergePrompt(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* sub-components                                                               */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      variants={ivScreenVariants}
      initial="initial"
      animate="animate"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
          {title}
        </h2>
        <p style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--iv-ink-faint)' }}>
          {subtitle}
        </p>
      </div>
      {children}
    </motion.section>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      variants={ivStaggerParent}
      initial="initial"
      animate="animate"
      style={{
        display: 'grid',
        gap: '0.9rem',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 20rem), 1fr))',
      }}
    >
      {children}
    </motion.div>
  );
}

function CompleteBadge({ complete, remaining }: { complete: boolean; remaining: number }) {
  if (complete) {
    return (
      <motion.span
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className={iv.badgeCovered}
        style={{ fontSize: '0.85rem', padding: '0.45rem 0.85rem' }}
        data-board-complete="true"
      >
        <PartyPopper className="h-4 w-4" aria-hidden />
        Every department decided
      </motion.span>
    );
  }
  return (
    <span
      className={iv.badgePending}
      style={{ fontSize: '0.85rem', padding: '0.45rem 0.85rem' }}
      data-board-complete="false"
    >
      <ShieldCheck className="h-4 w-4" aria-hidden />
      {remaining > 0 ? `${remaining} still to decide` : 'Finishing up…'}
    </span>
  );
}

function AddDepartmentCard({
  adding,
  value,
  onOpen,
  onCancel,
  onChange,
  onSubmit,
  disabled,
}: {
  adding: boolean;
  value: string;
  onOpen: () => void;
  onCancel: () => void;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  if (!adding) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className={iv.card}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          minHeight: '10rem',
          cursor: 'pointer',
          border: '1.5px dashed var(--iv-line-strong)',
          background: 'transparent',
          color: 'var(--iv-ink-soft)',
        }}
      >
        <Plus className="h-6 w-6" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
        <span style={{ fontWeight: 600 }}>Add a department</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--iv-ink-faint)' }}>
          Something unique to your business
        </span>
      </button>
    );
  }
  return (
    <div className={iv.card} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
        Name your department
      </label>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="e.g. Franchise support"
        className={iv.input}
        style={{
          background: 'var(--iv-surface-2)',
          border: '1px solid var(--iv-line-strong)',
          borderRadius: 'var(--iv-radius-sm)',
          padding: '0.6rem 0.75rem',
          color: 'var(--iv-ink)',
          fontSize: '0.9rem',
        }}
      />
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" onClick={onSubmit} disabled={!value.trim()} className={iv.btnPrimary}>
          <Plus className="h-4 w-4" aria-hidden />
          Add
        </button>
        <button type="button" onClick={onCancel} className={iv.btnGhost}>
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </button>
      </div>
    </div>
  );
}

function MergeKeepDialog({
  prompt,
  onMerge,
  onKeep,
  onCancel,
}: {
  prompt: MergePrompt;
  onMerge: () => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Merge or keep this department"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6, 8, 12, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        zIndex: 60,
      }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className={ivcx(iv.dark, iv.panelCard)}
        style={{ maxWidth: '30rem', width: '100%', display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <GitMerge className="h-5 w-5" aria-hidden style={{ color: 'var(--iv-accent-strong)' }} />
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: 'var(--iv-ink)' }}>
            This looks a lot like “{prompt.matchName}”
          </h3>
        </div>
        <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--iv-ink-soft)' }}>
          You already have a <strong>{prompt.matchName}</strong> department. Want to fold
          “{prompt.name}” into it, or keep it as its own separate department?
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button type="button" onClick={onMerge} className={iv.btnPrimary}>
            <GitMerge className="h-4 w-4" aria-hidden />
            Merge into {prompt.matchName}
          </button>
          <button type="button" onClick={onKeep} className={iv.btnGhost}>
            <Building2 className="h-4 w-4" aria-hidden />
            Keep separate
          </button>
          <button type="button" onClick={onCancel} className={iv.btnQuiet}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
