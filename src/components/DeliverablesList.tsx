/**
 * DeliverablesList Component
 * Displays deliverables (files, URLs, artifacts) for a task.
 *
 * Image deliverables (duck-fix): renders an inline <img> thumbnail that links
 * to the full-size preview.  Non-image files keep the Finder-reveal behaviour.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, Link as LinkIcon, Package, ExternalLink, Eye, Image as ImageIcon } from 'lucide-react';
import { debug } from '@/lib/debug';
import type { TaskDeliverable } from '@/lib/types';

/** Image file extensions (lower-case, with leading dot). */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff', '.tif', '.svg']);

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

  /** Return true when the deliverable path points to an image file. */
  const isImageDeliverable = (deliverable: TaskDeliverable): boolean => {
    if (deliverable.deliverable_type !== 'file' || !deliverable.path) return false;
    const ext = deliverable.path.slice(deliverable.path.lastIndexOf('.')).toLowerCase();
    return IMAGE_EXTS.has(ext);
  };

  /**
   * Build the URL for serving a file deliverable inline via /api/files/preview.
   * The preview route now supports images (duck-fix).
   */
  const previewUrl = (filePath: string): string =>
    `/api/files/preview?path=${encodeURIComponent(filePath)}`;

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
                  {/* Preview button for HTML or image files */}
                  {deliverable.deliverable_type === 'file' && deliverable.path &&
                    (deliverable.path.endsWith('.html') || deliverable.path.endsWith('.htm') || isImg) && (
                    <button
                      onClick={() => handlePreview(deliverable)}
                      className="flex-shrink-0 p-1.5 hover:bg-gray-200 rounded-lg text-cyan-600 transition-colors"
                      title={isImg ? 'View full-size image' : 'Preview in browser'}
                    >
                      <Eye className="w-4 h-4" />
                    </button>
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
