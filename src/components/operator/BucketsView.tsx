'use client';

/**
 * BucketsView , "By Type" output buckets for the Operator Console Workspace.
 *
 * Track B3 / SCOPE-ADDITION Addition 2.
 *
 * Two stages:
 *   1. Grid of 7 bucket cards. Each card shows label, description, count,
 *      and (when present) a "latest at" timestamp.
 *   2. After the operator clicks a card, the view swaps to a paginated
 *      file grid for that bucket. Image and video items render with
 *      thumbnails. All other kinds get an icon + label.
 *
 * Drives the `/api/operator/workspace/buckets` endpoint.
 */

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Image as ImageIcon,
  Film,
  Music,
  FileCode,
  FileText,
  Search,
  Globe,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

type BucketId = 'images' | 'videos' | 'audio' | 'apps' | 'documents' | 'code' | 'searches';

interface BucketSummary {
  id: BucketId;
  label: string;
  description: string;
  count: number;
  latest: number | null;
}

interface BucketItem {
  bucket: BucketId;
  source: string;
  name: string;
  relPath: string;
  bytes: number;
  mtime: number;
  kind: string;
  ext: string;
  fileUrl: string;
  thumbUrl?: string;
  extra?: Record<string, unknown>;
}

const BUCKET_VISUAL: Record<BucketId, { color: string; icon: LucideIcon }> = {
  images: { color: '#8B5CF6', icon: ImageIcon },
  videos: { color: '#EC4899', icon: Film },
  audio: { color: '#F59E0B', icon: Music },
  apps: { color: '#06B6D4', icon: Globe },
  documents: { color: '#10B981', icon: FileText },
  code: { color: '#3B82F6', icon: FileCode },
  searches: { color: '#22D3EE', icon: Search },
};

function humanBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function humanTime(ms: number | null): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface BucketsViewProps {
  onOpenItem?: (item: BucketItem) => void;
}

export default function BucketsView({ onOpenItem }: BucketsViewProps) {
  const [summary, setSummary] = useState<BucketSummary[] | null>(null);
  const [activeBucket, setActiveBucket] = useState<BucketId | null>(null);
  const [items, setItems] = useState<BucketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = 60;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/operator/workspace/buckets');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setSummary(data.summary || []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeBucket) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          bucket: activeBucket,
          limit: String(limit),
          offset: String(offset),
        });
        const res = await fetch(`/api/operator/workspace/buckets?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setItems(data.items || []);
          const s = (data.summary as BucketSummary[] | undefined)?.find((b) => b.id === activeBucket);
          setTotal(s?.count || (data.items || []).length);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBucket, offset]);

  if (!activeBucket) {
    return (
      <div>
        <h3 className="text-section-title text-bcc-text mb-2">Output Buckets</h3>
        <p className="text-[13px] text-bcc-text-secondary mb-5 max-w-[700px]">
          Files aggregated across every agent scratch, the studio vault, and the research history.
          Pick a bucket to drill in.
        </p>

        {error && (
          <div className="mb-4 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {loading && !summary && (
          <div className="flex items-center gap-2 text-[12px] text-bcc-text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading buckets...
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {(summary || []).map((b) => {
            const visual = BUCKET_VISUAL[b.id];
            const Icon = visual.icon;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setOffset(0);
                  setItems([]);
                  setActiveBucket(b.id);
                }}
                className="group relative overflow-hidden h-full rounded-xl border border-bcc-border bg-bcc-white p-5 text-left transition-shadow hover:shadow-md"
              >
                <div
                  className="pointer-events-none absolute -bottom-12 -right-10 w-36 h-36 rounded-full blur-3xl opacity-10 group-hover:opacity-20 transition-opacity"
                  style={{ background: visual.color }}
                />
                <div className="relative flex items-start justify-between mb-3">
                  <div
                    className="grid place-items-center w-10 h-10 rounded-lg"
                    style={{
                      background: `${visual.color}1a`,
                      color: visual.color,
                      border: `1px solid ${visual.color}33`,
                    }}
                  >
                    <Icon size={20} />
                  </div>
                  <span className="text-[12px] font-semibold text-bcc-text">{b.count}</span>
                </div>
                <div className="relative">
                  <h4 className="text-card-title text-bcc-text">{b.label}</h4>
                  <p className="mt-1.5 text-[12.5px] text-bcc-text-secondary leading-relaxed">
                    {b.description}
                  </p>
                  <div className="mt-3 text-[11px] uppercase tracking-[0.14em] text-bcc-text-muted">
                    Latest: {humanTime(b.latest)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const activeMeta = summary?.find((s) => s.id === activeBucket);
  const visual = BUCKET_VISUAL[activeBucket];
  const Icon = visual.icon;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setActiveBucket(null);
          setItems([]);
          setOffset(0);
        }}
        className="inline-flex items-center gap-1 text-[12px] text-bcc-text-secondary hover:text-bcc-text mb-3"
      >
        <ArrowLeft size={12} /> Back to buckets
      </button>

      <div className="flex items-center gap-3 mb-4">
        <span
          className="grid place-items-center w-10 h-10 rounded-lg"
          style={{
            background: `${visual.color}1a`,
            color: visual.color,
            border: `1px solid ${visual.color}33`,
          }}
        >
          <Icon size={20} />
        </span>
        <div>
          <h3 className="text-section-title text-bcc-text">{activeMeta?.label || activeBucket}</h3>
          <div className="text-[12px] text-bcc-text-muted">{activeMeta?.description}</div>
        </div>
        <div className="ml-auto text-[12px] text-bcc-text-secondary">
          {total ? `${total} item${total === 1 ? '' : 's'}` : '0 items'}
        </div>
      </div>

      {error && (
        <div className="mb-4 text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {loading && !items.length && (
        <div className="flex items-center gap-2 text-[12px] text-bcc-text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading items...
        </div>
      )}

      {!loading && !items.length && !error && (
        <div className="rounded-lg border border-dashed border-bcc-border bg-bcc-white p-6 text-center text-[13px] text-bcc-text-muted">
          Nothing in this bucket yet.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {items.map((it) => (
          <button
            key={`${it.source}:${it.relPath}:${it.mtime}`}
            type="button"
            onClick={() => onOpenItem?.(it)}
            className="group rounded-lg border border-bcc-border bg-bcc-white overflow-hidden text-left hover:shadow-md transition-shadow"
          >
            <div className="aspect-[4/3] bg-bcc-border-light grid place-items-center overflow-hidden">
              {it.bucket === 'images' && it.thumbUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={it.thumbUrl}
                  alt={it.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              )}
              {it.bucket === 'videos' && it.thumbUrl && (
                <video
                  src={it.thumbUrl}
                  preload="metadata"
                  muted
                  className="w-full h-full object-cover"
                />
              )}
              {it.bucket !== 'images' && it.bucket !== 'videos' && (
                <span className="text-bcc-text-muted" style={{ color: visual.color }}>
                  <Icon size={28} />
                </span>
              )}
            </div>
            <div className="px-3 py-2">
              <div className="text-[12px] text-bcc-text truncate">{it.name}</div>
              <div className="text-[11px] text-bcc-text-muted truncate">
                {it.source} - {humanBytes(it.bytes)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {total > limit && (
        <div className="mt-5 flex items-center justify-between text-[12px] text-bcc-text-secondary">
          <span>
            Showing {offset + 1}-{Math.min(offset + items.length, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0 || loading}
              className="px-3 py-1.5 rounded-md border border-bcc-border bg-bcc-white text-bcc-text-secondary hover:bg-bcc-border-light disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + items.length >= total || loading}
              className="px-3 py-1.5 rounded-md border border-bcc-border bg-bcc-white text-bcc-text-secondary hover:bg-bcc-border-light disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
