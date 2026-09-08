/**
 * /social/media/[assetId] — the F38 client-bound HTML video player mini-app.
 *
 * The planner sheet's "Watch video" HYPERLINK lands here. The page:
 *   1. fetches GET /api/social/media/{assetId} — the route resolves the asset
 *      THROUGH the authenticated company identity and mints a short-lived
 *      preview token,
 *   2. plays the CORRECT revision (the asset row pins content_revision; the
 *      player labels it on screen so the client sees which revision they are
 *      reviewing),
 *   3. shows poster + duration + captions/QC state and never offers a public
 *      upload — draft review stays private to the company,
 *   4. on expired preview access (401, renewable: true) offers a one-click
 *      renewal: re-fetch metadata while still authenticated, then re-play.
 *
 * No public uploads, no public listing — an unauthenticated visitor gets the
 * API's 403 and this page shows the sign-in-required state.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

interface AssetMeta {
  id: string;
  kind: string;
  cycle_id: string | null;
  content_revision: string | null;
  poster_url: string | null;
  duration_seconds: number | null;
  ratio: string | null;
  qc_state: string | null;
  watch_url: string;
}

interface PreviewInfo {
  url: string;
  token: string;
  expires_at: string;
  renewal: string;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown duration';
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SocialMediaPlayerPage() {
  const params = useParams<{ assetId: string }>();
  const assetId = params?.assetId;
  const [asset, setAsset] = useState<AssetMeta | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const loadedRef = useRef(false);

  const loadMetadata = useCallback(async () => {
    if (!assetId) return null;
    const res = await fetch(`/api/social/media/${encodeURIComponent(assetId)}`, {
      credentials: 'include',
    });
    if (res.status === 403) {
      setNeedsAuth(true);
      setError('Verified company sign-in is required to watch this video.');
      return null;
    }
    if (res.status === 404) {
      setError('This video link is not available.');
      return null;
    }
    if (res.status === 409) {
      setError('This video is still being prepared — check back after the next cycle.');
      return null;
    }
    if (!res.ok) {
      setError('Could not load this video.');
      return null;
    }
    const body = (await res.json()) as { asset: AssetMeta; preview: PreviewInfo };
    setAsset(body.asset);
    setPreview(body.preview);
    setNeedsAuth(false);
    setError(null);
    return body.preview;
  }, [assetId]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadMetadata();
  }, [loadMetadata]);

  const renew = useCallback(async () => {
    setRenewing(true);
    try {
      await loadMetadata();
    } finally {
      setRenewing(false);
    }
  }, [loadMetadata]);

  if (needsAuth) {
    return (
      <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Sign in required</h1>
        <p>{error}</p>
        <p style={{ color: '#666' }}>
          Open the planner link again after signing in to your Command Center account.
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Video unavailable</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!asset || !preview) {
    return (
      <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <p>Loading…</p>
      </main>
    );
  }

  const isVideo = asset.kind === 'video';

  return (
    <main style={{ maxWidth: 720, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
        Video review{asset.content_revision ? ` — revision ${asset.content_revision}` : ''}
        {asset.cycle_id ? ` · ${asset.cycle_id}` : ''}
      </h1>
      <p style={{ color: '#555', fontSize: '0.9rem' }}>
        {formatDuration(asset.duration_seconds)} · {asset.ratio || 'ratio unknown'}
        {asset.qc_state ? ` · QC: ${asset.qc_state}` : ''}
        {asset.poster_url ? ' · captions/poster as delivered' : ''}
      </p>
      {isVideo ? (
        <video
          controls
          playsInline
          poster={asset.poster_url || undefined}
          style={{ width: '100%', borderRadius: 8, background: '#000' }}
          onError={() => setError('This preview link has expired. Renew to keep watching.')}
        >
          <source src={preview.url} />
          Your browser cannot play this video inline.
        </video>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.url}
          alt={asset.id}
          style={{ width: '100%', borderRadius: 8 }}
        />
      )}
      <p style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          type="button"
          onClick={renew}
          disabled={renewing}
          style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer' }}
        >
          {renewing ? 'Renewing…' : 'Renew preview access'}
        </button>
        <span style={{ color: '#666', fontSize: '0.85rem' }}>
          Preview access expires {new Date(preview.expires_at).toLocaleTimeString()} and renews here.
        </span>
      </p>
      <p style={{ color: '#888', fontSize: '0.8rem' }}>
        Draft review is private to your company. A published link, once live, is delivered separately
        from this player.
      </p>
    </main>
  );
}