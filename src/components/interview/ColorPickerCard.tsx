'use client';

/**
 * ColorPickerCard — the rich control for the brand-color question (P1-1).
 *
 * The owner may type EITHER a hex code (#1E3A8A, 1e3a8a, #39f) OR a plain color
 * name ("navy", "forest green", "coral"). Both are resolved LIVE through
 * resolveBrandColor() — the exact same resolver the build side uses — so what the
 * owner sees previewed is precisely what lands on clients.brand_color and what
 * <BrandTheme/> re-themes the whole Command Center from.
 *
 * A native swatch picker stays in sync with the text field so the two are one
 * control: dragging the picker fills the field with the chosen hex; typing a name
 * that resolves points the picker at the resolved hex.
 *
 * Validation (client + echoed server-side by /api/interview/answer): the answer
 * is only submittable when resolveBrandColor() returns a non-null hex, and the
 * VALUE POSTed is that resolved #rrggbb — never the raw name — satisfying the
 * "color card writes a resolveBrandColor-valid hex" acceptance. brand_primary_color
 * is not required, so an empty field can be skipped (when the parent allows it).
 */

import { useCallback, useMemo, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { iv } from '@/components/interview/interview-theme';
import { resolveBrandColor } from '@/lib/branding';
import {
  CardActions,
  submitInterviewAnswer,
  type StructuredCardProps,
} from '@/components/interview/QuestionCard';

export default function ColorPickerCard({
  question,
  sessionId,
  questionNumber,
  knownValue,
  knownSource,
  onAnswered,
  onSkip,
  autoFocus,
}: StructuredCardProps) {
  // Memory: prefill with the brand color already on file (confirm-or-correct).
  const [raw, setRaw] = useState(knownValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = question.required === true;

  // Live resolution — recomputed on every keystroke so the preview never lies.
  const resolution = useMemo(() => resolveBrandColor(raw), [raw]);
  const hasInput = raw.trim().length > 0;
  const valid = resolution.hex != null;
  // Point the native picker at the resolved hex, or a neutral gray when unresolved.
  const swatchHex = resolution.hex ?? '#9ca3af';

  const submit = useCallback(async () => {
    setError(null);
    // Client-side gate: never POST a color we can't resolve to a real hex.
    if (!valid || !resolution.hex) {
      setError(
        'That color isn’t one we recognize yet — try a hex code like #1E3A8A or a name like “navy”.',
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    const confirmsKnown =
      !!knownSource &&
      !!knownValue &&
      resolution.hex.toLowerCase() === knownValue.trim().toLowerCase();
    const result = await submitInterviewAnswer({
      question,
      // Persist the RESOLVED hex, not the raw name — this is the value the acceptance
      // ("resolveBrandColor-valid hex") and the live re-theme both depend on.
      value: resolution.hex,
      questionNumber,
      sessionId,
      confirmedFromContext: confirmsKnown ? knownSource : undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAnswered({ question, value: resolution.hex, data: result.data });
  }, [busy, knownSource, knownValue, onAnswered, question, questionNumber, resolution.hex, sessionId, valid]);

  return (
    <div className="iv-field-block">
      <div className="iv-color-row">
        {/* Native swatch picker — dragging it fills the field with a hex. */}
        <label className="iv-color-swatch" style={{ position: 'relative' }}>
          <span
            aria-hidden
            className="iv-color-chip"
            style={{ backgroundColor: swatchHex }}
          />
          <input
            type="color"
            value={resolution.hex ?? '#000000'}
            onChange={(e) => {
              setRaw(e.target.value);
              if (error) setError(null);
            }}
            aria-label="Pick a color"
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0,
              cursor: 'pointer',
            }}
          />
        </label>

        <input
          type="text"
          className={iv.input}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (valid && !busy) void submit();
            }
          }}
          autoFocus={autoFocus}
          placeholder="#1E3A8A  ·  or  ·  navy"
          aria-label={question.prompt}
          aria-invalid={error ? true : undefined}
        />
      </div>

      {/* Live, honest preview of exactly what will be saved. */}
      {hasInput && (
        <p className={valid ? 'iv-color-note' : 'iv-color-note is-unresolved'}>
          {valid ? (
            <>
              <Check
                aria-hidden
                style={{
                  width: '1em',
                  height: '1em',
                  display: 'inline',
                  verticalAlign: '-0.15em',
                  marginRight: '0.35em',
                }}
              />
              {resolution.source === 'name'
                ? `We’ll use ${resolution.hex} for your brand.`
                : `Looks good — we’ll use ${resolution.hex}.`}
            </>
          ) : (
            <>
              <Palette
                aria-hidden
                style={{
                  width: '1em',
                  height: '1em',
                  display: 'inline',
                  verticalAlign: '-0.15em',
                  marginRight: '0.35em',
                }}
              />
              We don’t recognize that one yet — try a hex code or a common color
              name.
            </>
          )}
        </p>
      )}

      {error && (
        <p className="iv-error" role="alert">
          {error}
        </p>
      )}

      <CardActions
        onSubmit={submit}
        canSubmit={!busy && valid}
        busy={busy}
        required={required}
        onSkip={onSkip ? () => onSkip(question) : undefined}
      />
    </div>
  );
}
