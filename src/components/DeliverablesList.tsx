/**
 * DeliverablesList Component
 * Displays deliverables (files, URLs, artifacts) for a task.
 *
 * Image deliverables (duck-fix): renders an inline <img> thumbnail that links
 * to the full-size preview.  Gap F: every file deliverable also gets a
 * browser-reachable path - an in-browser preview for html/pdf/audio/video, and
 * a Download link for anything else (pptx, docx, ...) - so a web client is
 * never left with only the Finder-reveal button, which works on the server box.
 *
 * D14 (media presentation): image-TYPED deliverables take the image preview
 * path (the old file-only detection missed them entirely), audio renders as
 * playable audio and video as playable video, and a deliverable that carries a
 * Skill 75 artifact-meta envelope shows its revision alongside its approval
 * state (character/storyboard revisions included).
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, Link as LinkIcon, Package, ExternalLink, Eye, Download, Image as ImageIcon } from 'lucide-react';
import { debug } from '@/lib/debug';
import { parseSkill75Envelope, type Skill75ArtifactMeta } from '@/lib/validation';
import type { TaskDeliverable } from '@/lib/types';

/** Image file extensions (lower-case, with leading dot). */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.svg']);

/** Audio/video extensions /api/files/preview serves inline (its PREVIEW_MIME map). */
const AUDIO_EXTS = new Set(['.mp3', '.wav']);
const VIDEO_EXTS = new Set(['.mp4']);

/** Non-image types /api/files/preview serves inline (must match its PREVIEW_MIME). */
const INLINE_PREVIEW_EXTS = new Set(['.html', '.htm', '.pdf', '.mp3', '.wav', '.mp4']);

const extOf = (filePath: string): string => {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? '' : filePath.slice(dot).toLowerCase();
};

export type DeliverableMediaKind = 'image' | 'audio' | 'video' | null;

/**
 * The media presentation kind for one deliverable (D14).
 *
 * The named defect: `deliverable_type === 'image'` rows missed the image
 * preview path because detection looked at file extensions ONLY when the type
 * was 'file'. An image-typed deliverable now always takes the image path.
 * Audio/video kinds are extension-driven so a player is only rendered when the
 * preview route can actually serve the file.
 */
export function mediaKindOf(
  d: Pick<TaskDeliverable, 'deliverable_type' | 'path' | 'mime_type'>,
): DeliverableMediaKind {
  // A `url` deliverable is a link (rendered as one), and nothing renders
  // without a path — same shape as the detection this replaces.
  if (d.deliverable_type === 'url' || !d.path) return null;
  if (d.deliverable_type === 'image') return 'image';
  const ext = extOf(d.path);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  // Image MIME fallback: the <img> degrades to hidden when the preview route
  // cannot serve the extension (its onError handler), so this can never leave
  // a broken frame. Audio/video stay extension-only (a player that cannot load
  // is worse than a download link).
  const mime = (d.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  return null;
}

/**
 * D14 — the per-artifact revision + approval state registered alongside a
 * deliverable (a Skill 75 `artifact_meta` envelope embedded in the deliverable
 * description). Rendered so character and storyboard revisions sit next to
 * their approval state in the task UI; the durable deliverable/activity rows
 * remain the copy of record (the board is only a view of the run).
 */
export function parseArtifactMeta(description?: string | null): Skill75ArtifactMeta | null {
  if (!description) return null;
  const candidates = [description.trim(), ...description.split('\n').map((l) => l.trim())];
  for (const c of candidates) {
    if (!c.startsWith('{')) continue;
    const env = parseSkill75Envelope(c);
    if (env && env.kind === 'artifact_meta') return env;
  }
  return null;
}

interface DeliverablesListProps {
  taskId: string;
  /**
   * U104 (E4-7) — the producer's friendly label (e.g. "the Anthology
   * Engine", "a Skill 6 funnel build") when this task is an engine-ingested
   * board-producer card. Verified: this tab reads ONLY `task_deliverables`
   * (see /api/tasks/[id]/deliverables), a table no board-producer engine
   * writes to, so an engine card's deliverables list is honestly always
   * empty here — see the card's own face (e.g. the Anthology Gate Panel's
   * "The work" zone) for where they actually live. Only consulted for the
   * EMPTY-state copy — a task that DOES have registered deliverables always
   * renders them, unchanged. `undefined`/`null` keeps the ORIGINAL generic
   * empty copy.
   */
  engineLabel?: string | null;
}

export function DeliverablesList({ taskId, engineLabel }: DeliverablesListProps) {
  const [deliverables, setDeliverables] = useState<TaskDeliverable[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDeliverables = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/deliverables`);
      if (res.ok) {
        const data = await res.json();
        setDeliverables(data);
      }
    } catch (error) {
      console.error('Failed to load deliverables:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadDeliverables();
  }, [loadDeliverables]);

  /** Return true when the deliverable is an image (type, extension, or MIME). */
  const isImageDeliverable = (deliverable: TaskDeliverable): boolean =>
    mediaKindOf(deliverable) === 'image';

  /** True when the browser can show the file inline (html, pdf, audio, video, images). */
  const canPreview = (deliverable: TaskDeliverable): boolean =>
    deliverable.deliverable_type !== 'url' &&
    !!deliverable.path &&
    (mediaKindOf(deliverable) !== null || INLINE_PREVIEW_EXTS.has(extOf(deliverable.path)));

  /**
   * Build the URL for serving a file deliverable inline via /api/files/preview.
   * The preview route now supports images (duck-fix).
   */
  const previewUrl = (filePath: string): string =>
    `/api/files/preview?path=${encodeURIComponent(filePath)}`;

  /** Same route and path allow-list, served as an attachment (any file type). */
  const downloadUrl = (filePath: string): string => `${previewUrl(filePath)}&download=1`;

  const getDeliverableIcon = (deliverable: TaskDeliverable) => {
    if (isImageDeliverable(deliverable)) {
      return <ImageIcon className="w-5 h-5" />;
    }
    switch (deliverable.deliverable_type) {
      case 'file':
        return <FileText className="w-5 h-5" />;
      case 'url':
        return <LinkIcon className="w-5 h-5" />;
      case 'artifact':
        return <Package className="w-5 h-5" />;
      default:
        return <FileText className="w-5 h-5" />;
    }
  };

  const handleOpen = async (deliverable: TaskDeliverable) => {
    // URLs open directly in new tab
    if (deliverable.deliverable_type === 'url' && deliverable.path) {
      window.open(deliverable.path, '_blank');
      return;
    }

    // Files - try to open in Finder
    if (deliverable.path) {
      try {
        debug.file('Opening file in Finder', { path: deliverable.path });
        const res = await fetch('/api/files/reveal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: deliverable.path }),
        });

        if (res.ok) {
          debug.file('Opened in Finder successfully');
          return;
        }

        const error = await res.json();
        debug.file('Failed to open', error);

        if (res.status === 404) {
          alert(`File not found:\n${deliverable.path}\n\nThe file may have been moved or deleted.`);
        } else if (res.status === 403) {
          alert(`Cannot open this location:\n${deliverable.path}\n\nPath is outside allowed directories.`);
        } else {
          throw new Error(error.error || 'Unknown error');
        }
      } catch (error) {
        console.error('Failed to open file:', error);
        // Fallback: copy path to clipboard
        try {
          await navigator.clipboard.writeText(deliverable.path);
          alert(`Could not open Finder. Path copied to clipboard:\n${deliverable.path}`);
        } catch {
          alert(`File path:\n${deliverable.path}`);
        }
      }
    }
  };

  const handlePreview = (deliverable: TaskDeliverable) => {
    if (deliverable.path) {
      debug.file('Opening preview', { path: deliverable.path });
      window.open(previewUrl(deliverable.path), '_blank');
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-500">Loading deliverables...</div>
      </div>
    );
  }

  if (deliverables.length === 0) {
    if (engineLabel) {
      return (
        <div
          className="flex flex-col items-center justify-center py-8 text-gray-500 text-center px-4"
          data-testid="engine-card-empty-deliverables"
        >
          <div className="text-4xl mb-2">📦</div>
          <p className="text-sm italic text-gray-400">
            Captured via {engineLabel} — this card family&apos;s build outputs are not
            recorded in Command Center&apos;s Deliverables list. Check the card&apos;s own
            Overview tab for where its outputs actually live.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-8 text-gray-500">
        <div className="text-4xl mb-2">📦</div>
        <p>No deliverables yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deliverables.map((deliverable) => {
        const isImg = isImageDeliverable(deliverable);
        const mediaKind = mediaKindOf(deliverable);
        const artifactMeta = parseArtifactMeta(deliverable.description);
        return (
          <div
            key={deliverable.id}
            className="flex gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200 hover:border-indigo-300 transition-colors"
          >
            {/* Icon */}
            <div className="flex-shrink-0 text-indigo-600">
              {getDeliverableIcon(deliverable)}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              {/* Title - clickable for URLs */}
              <div className="flex items-start justify-between gap-2">
                {deliverable.deliverable_type === 'url' && deliverable.path ? (
                  <a
                    href={deliverable.path}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline flex items-center gap-1.5"
                  >
                    {deliverable.title}
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <h4 className="font-medium text-gray-900">{deliverable.title}</h4>
                )}
                <div className="flex items-center gap-1">
                  {/* Preview button for anything the browser can show inline */}
                  {canPreview(deliverable) && (
                    <button
                      onClick={() => handlePreview(deliverable)}
                      className="flex-shrink-0 p-1.5 hover:bg-gray-200 rounded-lg text-cyan-600 transition-colors"
                      title={isImg ? 'View full-size image' : 'Preview in browser'}
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  )}
                  {/* Download link: works from any browser, unlike Finder reveal */}
                  {deliverable.deliverable_type !== 'url' && deliverable.path && (
                    <a
                      href={downloadUrl(deliverable.path)}
                      download
                      className="flex-shrink-0 p-1.5 hover:bg-gray-200 rounded-lg text-emerald-600 transition-colors"
                      title="Download file"
                      aria-label={`Download ${deliverable.title}`}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  )}
                  {/* Open/Reveal button */}
                  {deliverable.path && (
                    <button
                      onClick={() => handleOpen(deliverable)}
                      className="flex-shrink-0 p-1.5 hover:bg-gray-200 rounded-lg text-indigo-600 transition-colors"
                      title={deliverable.deliverable_type === 'url' ? 'Open URL' : 'Reveal in Finder'}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Inline image thumbnail (duck-fix) */}
              {isImg && deliverable.path && (
                <a
                  href={previewUrl(deliverable.path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-2"
                  title="Click to view full-size"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl(deliverable.path)}
                    alt={deliverable.title}
                    className="max-h-48 max-w-full rounded border border-gray-200 object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
                    onError={(e) => {
                      // Hide broken image on load error (file may not be served yet).
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </a>
              )}

              {/* Inline playable audio (D14) — served through the existing
                  authenticated preview path, never a raw filesystem path. */}
              {mediaKind === 'audio' && deliverable.path && (
                <audio
                  className="mt-2 w-full max-w-md"
                  controls
                  preload="metadata"
                  src={previewUrl(deliverable.path)}
                  data-testid="deliverable-audio"
                >
                  <a href={downloadUrl(deliverable.path)}>Download {deliverable.title}</a>
                </audio>
              )}

              {/* Inline playable video (D14) */}
              {mediaKind === 'video' && deliverable.path && (
                <video
                  className="mt-2 max-h-64 max-w-full rounded border border-gray-200"
                  controls
                  preload="metadata"
                  src={previewUrl(deliverable.path)}
                  data-testid="deliverable-video"
                />
              )}

              {/* D14 — revision alongside approval state (character bible /
                  storyboard revisions included). Durable rows are the copy of
                  record; this is the task-UI view of them. */}
              {artifactMeta && (
                <div className="mt-1 text-xs text-gray-500" data-testid="deliverable-artifact-meta">
                  {artifactMeta.artifact_kind} · rev {artifactMeta.revision} · {artifactMeta.approval_state}
                </div>
              )}

              {/* Description */}
              {deliverable.description && (
                <p className="text-sm text-gray-600 mt-1">
                  {deliverable.description}
                </p>
              )}

              {/* Path - clickable for URLs */}
              {deliverable.path && (
                deliverable.deliverable_type === 'url' ? (
                  <a
                    href={deliverable.path}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 p-2 bg-gray-100 rounded text-xs text-indigo-600 hover:text-indigo-700 font-mono break-all block hover:bg-gray-200 transition-colors"
                  >
                    {deliverable.path}
                  </a>
                ) : (
                  <div className="mt-2 p-2 bg-gray-100 rounded text-xs text-gray-600 font-mono break-all">
                    {deliverable.path}
                  </div>
                )
              )}

              {/* Metadata */}
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                <span className="capitalize">{deliverable.deliverable_type}</span>
                <span>•</span>
                <span>{formatTimestamp(deliverable.created_at)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
