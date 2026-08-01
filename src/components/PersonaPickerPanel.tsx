'use client';

/**
 * U064 — Persona Picker Panel (voice/topic axis).
 *
 * Displays the resolved voice/topic persona blend and offers two distinct actions:
 *
 *   Action A — "re-aim" (the DEFAULT): changes an input field (audience label,
 *              topic hint) and re-runs the blend.  Writes NO persona id.
 *              Governance stays on.  This action triggers when the primary
 *              submit control is used with NO other interaction.
 *
 *   Action B — "name the voice" (express client choice): writes a specific
 *              persona id + source.  Suppresses the blend for this task.
 *              NEVER pre-selected; its consequence is stated on the button
 *              in plain words.
 *
 * Fail-quiet: renders NOTHING when the bundle is null (mirrors
 * AudienceConfirmPanel's early-return pattern).  Mounted beside
 * AudienceConfirmPanel in TaskModal.
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, UserCheck, AlertTriangle } from 'lucide-react';

interface BundleVoiceDecision {
  persona_id?: string | null;
  display_name?: string | null;
  collapsed?: boolean;
}

interface PersonaBundleDisplay {
  voice: BundleVoiceDecision;
  topic_persona?: { persona_id?: string | null; display_name?: string | null } | null;
  blend_directive?: string | null;
  rationale?: Record<string, unknown> | null;
  task_personas?: Array<Record<string, unknown>> | null;
}

interface PersonaBundleApiResponse {
  task_id: string;
  bundle: PersonaBundleDisplay | null;
  confirm_state: string | null;
  catalog_version: string | null;
  client_persona_id?: string | null;
  client_persona_source?: string | null;
  client_persona_set_at?: string | null;
}

interface PersonaPickerPanelProps {
  taskId: string;
  /** Called after a successful action so the modal/board can refresh. */
  onConfirmed?: () => void;
}

function whyLine(bundle: PersonaBundleDisplay): string {
  const rationale = bundle.rationale;
  if (rationale && typeof rationale.collapse === 'string' && rationale.collapse.trim()) {
    return rationale.collapse;
  }
  if (rationale && typeof rationale.topic_persona === 'string' && rationale.topic_persona.trim()) {
    return rationale.topic_persona;
  }
  return 'A blended persona governs this deck, derived from audience, topic, and conversion goal.';
}

export function PersonaPickerPanel({ taskId, onConfirmed }: PersonaPickerPanelProps) {
  const [bundle, setBundle] = useState<PersonaBundleDisplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audienceInput, setAudienceInput] = useState('');
  const [topicInput, setTopicInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/persona-bundle`);
      if (res.ok) {
        const data: PersonaBundleApiResponse = await res.json();
        setBundle(data.bundle ?? null);
      } else {
        setBundle(null);
      }
    } catch {
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const postChoice = useCallback(
    async (body: Record<string, unknown>) => {
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(`/api/tasks/${taskId}/persona-choice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const respBody = await res.json().catch(() => ({} as { error?: string }));
          setError(respBody.error || 'Failed to process persona choice');
          return;
        }
        setAudienceInput('');
        setTopicInput('');
        await load();
        onConfirmed?.();
      } catch {
        setError('Failed to process persona choice');
      } finally {
        setSubmitting(false);
      }
    },
    [taskId, load, onConfirmed],
  );

  // ── Fail-quiet: no bundle -> render nothing ─────────────────────────
  if (loading || !bundle) return null;

  const voicePersona = bundle.voice;
  const topicPersona = bundle.topic_persona;
  const blended = !voicePersona?.collapsed;
  const directive = bundle.blend_directive;
  const why = whyLine(bundle);

  return (
    <div
      className="mb-4 rounded-xl border border-violet-300 bg-violet-50 p-4"
      data-testid="persona-picker-panel"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-violet-100 p-1.5">
          <Sparkles className="h-4 w-4 text-violet-700" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-violet-900" data-testid="persona-picker-title">
            Persona Blend
          </h4>

          {/* Voice persona */}
          <p className="mt-1 text-xs text-violet-800" data-testid="persona-picker-voice">
            <span className="font-medium">Voice:</span>{' '}
            {voicePersona?.display_name ?? voicePersona?.persona_id ?? 'Resolving…'}
          </p>

          {/* Topic persona */}
          {topicPersona && (
            <p className="mt-0.5 text-xs text-violet-800" data-testid="persona-picker-topic">
              <span className="font-medium">Topic:</span>{' '}
              {topicPersona.display_name ?? topicPersona.persona_id ?? 'Resolving…'}
            </p>
          )}

          {/* Blend state */}
          <p className="mt-0.5 text-xs text-violet-800" data-testid="persona-picker-blend-state">
            {blended
              ? 'Voice + topic personas are distinct (genuine blend).'
              : 'Voice and topic collapsed onto a single persona.'}
          </p>

          {/* Blend directive */}
          {directive && (
            <div className="mt-1 overflow-x-auto" data-testid="persona-picker-directive">
              <p className="text-xs text-violet-700 whitespace-pre-wrap">{directive}</p>
            </div>
          )}

          {/* Why line */}
          <p className="mt-2 text-xs italic text-violet-700" data-testid="persona-picker-why">
            {why}
          </p>

          {error && (
            <p className="mt-2 text-xs font-medium text-red-700" data-testid="persona-picker-error">
              {error}
            </p>
          )}

          {/* ── Action A: re-aim (default submit — changes inputs, re-runs blend) ── */}
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={audienceInput}
                onChange={(e) => setAudienceInput(e.target.value)}
                placeholder="Re-aim the audience…"
                className="flex-1 rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-violet-500 focus:outline-none"
                data-testid="persona-picker-audience-input"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder="Re-aim the topic…"
                className="flex-1 rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-violet-500 focus:outline-none"
                data-testid="persona-picker-topic-input"
              />
              <button
                type="button"
                disabled={submitting || (!audienceInput.trim() && !topicInput.trim())}
                onClick={() =>
                  postChoice({
                    action: 'reaim',
                    audience_label: audienceInput.trim() || undefined,
                    topic_hint: topicInput.trim() || undefined,
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-60"
                data-testid="persona-picker-reaim-submit"
              >
                <UserCheck className="h-3.5 w-3.5" />
                Re-aim
              </button>
            </div>
          </div>

          {/* ── Action B: name the voice (express client choice) ── */}
          <div className="mt-3 border-t border-violet-200 pt-3">
            <p className="text-xs text-violet-700" data-testid="persona-picker-name-voice-consequence">
              Name the voice yourself — the blended persona will not govern this deck.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                placeholder="Persona ID…"
                className="flex-1 rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-violet-500 focus:outline-none"
                data-testid="persona-picker-name-voice-input"
              />
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  const input = document.querySelector<HTMLInputElement>(
                    '[data-testid="persona-picker-name-voice-input"]',
                  );
                  const personaId = input?.value?.trim();
                  if (!personaId) return;
                  postChoice({
                    action: 'name-voice',
                    persona_id: personaId,
                    persona_source: 'client-choice',
                  });
                  if (input) input.value = '';
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
                data-testid="persona-picker-name-voice-submit"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Name the voice
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
