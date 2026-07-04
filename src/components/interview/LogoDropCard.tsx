'use client';

/**
 * LogoDropCard — the rich control for the brand-logo question (P1-1).
 *
 * The logo question stores a URL (clients.logo_url), so the owner has two paths,
 * both landing on the same value:
 *   1. Paste a public link to the logo (the primary path — matches the prompt).
 *   2. Drag-and-drop (or pick) an image file, which we read to a data: URL for an
 *      instant preview and submit as the value; the P1-2 route mirrors it onto
 *      clients.logo_url so <BrandTheme/> swaps the mark app-wide.
 *
 * Validation (client + echoed server-side): the value must be a well-formed
 * http(s) URL OR a data:image/… URL — nothing else can be submitted. brand_logo
 * is not required, so an empty field can be skipped when the parent allows it.
 * There is deliberately no hosting/upload step here (out of this item's scope);
 * a dropped file is carried inline so the "logo drop stores clients.logo_url"
 * acceptance holds without a new backend.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { ImagePlus, Link2, UploadCloud, X } from 'lucide-react';
import { iv, ivcx } from '@/components/interview/interview-theme';
import {
  CardActions,
  submitInterviewAnswer,
  type StructuredCardProps,
} from '@/components/interview/QuestionCard';

/** Largest inline (data-URL) logo we accept — keeps a base64 blob out of the DB. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

/** True for a public http(s) link or a data:image/… URL — the only valid shapes. */
function isValidLogoUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^data:image\/[a-z0-9.+-]+;/i.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function LogoDropCard({
  question,
  sessionId,
  onAnswered,
  onSkip,
  autoFocus,
}: StructuredCardProps) {
  const [value, setValue] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const required = question.required === true;

  const valid = useMemo(() => isValidLogoUrl(value), [value]);

  const acceptFile = useCallback((file: File) => {
    setError(null);
    setPreviewFailed(false);
    if (!file.type.startsWith('image/')) {
      setError('That file isn’t an image — try a PNG, JPG, or SVG.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('That image is a bit large — paste a public link to it instead.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setValue(reader.result);
    };
    reader.onerror = () =>
      setError('We couldn’t read that file — try again or paste a link.');
    reader.readAsDataURL(file);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) acceptFile(file);
    },
    [acceptFile],
  );

  const submit = useCallback(async () => {
    setError(null);
    // Client-side gate: only a real link or a data:image URL may go to the wire.
    if (!isValidLogoUrl(value)) {
      setError('Paste a public link to your logo, or drop an image file above.');
      return;
    }
    if (busy) return;
    setBusy(true);
    const result = await submitInterviewAnswer({
      questionId: question.id,
      storeOn: question.storeOn,
      kind: 'url',
      value: value.trim(),
      sessionId,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAnswered({ question, value: value.trim(), data: result.data });
  }, [busy, onAnswered, question, sessionId, value]);

  const showPreview = valid && !previewFailed;

  return (
    <div className="iv-field-block">
      {/* Drop zone (also opens the file picker on click / keyboard). */}
      <div
        role="button"
        tabIndex={0}
        className={ivcx('iv-dropzone', dragOver && 'is-dragover')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Upload a logo image, or drop one here"
      >
        {showPreview ? (
          <div className="iv-logo-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value}
              alt="Your logo preview"
              onError={() => setPreviewFailed(true)}
              style={{ maxHeight: 96, maxWidth: '100%', objectFit: 'contain' }}
            />
            <button
              type="button"
              className={iv.btnQuiet}
              onClick={(e) => {
                e.stopPropagation();
                setValue('');
                setPreviewFailed(false);
                setError(null);
              }}
            >
              <X
                aria-hidden
                style={{
                  width: '1em',
                  height: '1em',
                  display: 'inline',
                  verticalAlign: '-0.15em',
                  marginRight: '0.35em',
                }}
              />
              Remove
            </button>
          </div>
        ) : (
          <div className="iv-dropzone-empty">
            {dragOver ? (
              <UploadCloud aria-hidden style={{ width: 32, height: 32 }} />
            ) : (
              <ImagePlus aria-hidden style={{ width: 32, height: 32 }} />
            )}
            <span>
              {dragOver
                ? 'Drop your logo to add it'
                : 'Drop your logo here, or click to choose a file'}
            </span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) acceptFile(file);
            // Allow re-selecting the same file after a remove.
            e.target.value = '';
          }}
        />
      </div>

      {/* Or paste a public link. */}
      <div className="iv-color-row" style={{ marginTop: '0.75rem' }}>
        <span aria-hidden className="iv-input-icon">
          <Link2 style={{ width: 18, height: 18, opacity: 0.6 }} />
        </span>
        <input
          type="url"
          inputMode="url"
          className={iv.input}
          value={value.startsWith('data:') ? '' : value}
          onChange={(e) => {
            setValue(e.target.value);
            setPreviewFailed(false);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (valid && !busy) void submit();
            }
          }}
          autoFocus={autoFocus}
          placeholder="https://example.com/logo.png"
          aria-label="Public link to your logo"
          aria-invalid={error ? true : undefined}
        />
      </div>

      {previewFailed && valid && (
        <p className="iv-color-note is-unresolved">
          We couldn’t load a preview from that link — it’ll still be saved, but
          double-check it’s a public image URL.
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
