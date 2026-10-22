/**
 * S75-W08-U2 (D14) — media presentation in the task UI.
 *
 * "Render image-typed deliverables through the existing image preview path
 * (the current file-only detection misses image types), audio as playable
 * audio, video as playable video, with character and storyboard revisions
 * alongside approval state."
 *
 * Real render proof (jsdom + @testing-library/react — see
 * vitest.component.config.ts):
 *
 *   npx vitest run --config vitest.component.config.ts tests/unit/w08-u2-deliverables-media-render.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

import { DeliverablesList, mediaKindOf, parseArtifactMeta } from '../../src/components/DeliverablesList';

afterEach(() => cleanup());

const mk = (
  id: string,
  deliverable_type: string,
  title: string,
  p: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  task_id: 't1',
  deliverable_type,
  title,
  path: p,
  created_at: '2026-10-22T10:00:00.000Z',
  ...extra,
});

const META_ENVELOPE = JSON.stringify({
  contract: 'skill75',
  version: 1,
  kind: 'artifact_meta',
  artifact_kind: 'character_bible',
  revision: 3,
  approval_state: 'approved',
});

describe('DeliverablesList media presentation (D14)', () => {
  it('renders an image-TYPED deliverable through the image preview path (the file-only detection bug)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [mk('d1', 'image', 'Character ref', '/p/char-ref.png')],
    })) as unknown as typeof fetch;

    render(<DeliverablesList taskId="t1" />);
    await waitFor(() => screen.getByText('Character ref'));

    // The inline thumbnail now renders for deliverable_type === 'image'
    // (previously only type 'file' + an image extension was detected).
    const img = document.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(`/api/files/preview?path=${encodeURIComponent('/p/char-ref.png')}`);

    const card = screen.getByText('Character ref').closest('.flex.gap-3') as HTMLElement;
    expect(within(card).queryByTitle('View full-size image')).not.toBeNull();
  });

  it('renders playable audio and playable video inline, and keeps downloads for both', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        mk('d1', 'file', 'Theme song', '/p/Song.mp3'),
        mk('d2', 'file', 'Final cut', '/p/Final.mp4'),
      ],
    })) as unknown as typeof fetch;

    render(<DeliverablesList taskId="t1" />);
    await waitFor(() => screen.getByText('Theme song'));

    const audio = screen.getByTestId('deliverable-audio') as HTMLAudioElement;
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute('src')).toBe(`/api/files/preview?path=${encodeURIComponent('/p/Song.mp3')}`);

    const video = screen.getByTestId('deliverable-video') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.controls).toBe(true);
    expect(video.getAttribute('src')).toBe(`/api/files/preview?path=${encodeURIComponent('/p/Final.mp4')}`);

    const songCard = screen.getByText('Theme song').closest('.flex.gap-3') as HTMLElement;
    expect(within(songCard).getByLabelText('Download Theme song')).not.toBeNull();
  });

  it('shows character/storyboard revision alongside its approval state from the durable envelope', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        mk('d1', 'image', 'Continuity bible', '/p/bible.png', {
          description: `character bible revision record\n${META_ENVELOPE}`,
        }),
      ],
    })) as unknown as typeof fetch;

    render(<DeliverablesList taskId="t1" />);
    await waitFor(() => screen.getByTestId('deliverable-artifact-meta'));
    const meta = screen.getByTestId('deliverable-artifact-meta');
    expect(meta.textContent).toContain('character_bible');
    expect(meta.textContent).toContain('rev 3');
    expect(meta.textContent).toContain('approved');
  });

  it('still gives non-previewable files a download only — no dead player (gap F regression)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [mk('d1', 'file', 'Deck', '/p/Deck-FINAL.pptx')],
    })) as unknown as typeof fetch;

    render(<DeliverablesList taskId="t1" />);
    await waitFor(() => screen.getByText('Deck'));

    const card = screen.getByText('Deck').closest('.flex.gap-3') as HTMLElement;
    expect(within(card).queryByTestId('deliverable-audio')).toBeNull();
    expect(within(card).queryByTestId('deliverable-video')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(within(card).getByLabelText('Download Deck')).not.toBeNull();
    expect(within(card).queryByTitle('Preview in browser')).toBeNull();
  });
});

describe('mediaKindOf / parseArtifactMeta (pure)', () => {
  it('classifies image types, image extensions, audio and video extensions', () => {
    expect(mediaKindOf({ deliverable_type: 'image', path: '/p/thing.dat', mime_type: null })).toBe('image');
    expect(mediaKindOf({ deliverable_type: 'file', path: '/p/x.PNG', mime_type: null })).toBe('image');
    expect(mediaKindOf({ deliverable_type: 'file', path: '/p/x.mp3', mime_type: null })).toBe('audio');
    expect(mediaKindOf({ deliverable_type: 'artifact', path: '/p/x.mp4', mime_type: null })).toBe('video');
    expect(mediaKindOf({ deliverable_type: 'file', path: '/p/x.pptx', mime_type: null })).toBeNull();
    expect(mediaKindOf({ deliverable_type: 'image', path: null, mime_type: null })).toBeNull();
    // A `url` deliverable is rendered as its link — never as an embedded player.
    expect(mediaKindOf({ deliverable_type: 'url', path: 'https://example.com/x.png', mime_type: null })).toBeNull();
  });

  it('parses the artifact-meta envelope from a description and rejects malformed metadata', () => {
    expect(parseArtifactMeta(`note\n${META_ENVELOPE}`)?.revision).toBe(3);
    expect(parseArtifactMeta('plain prose, no envelope')).toBeNull();
    expect(parseArtifactMeta('{"contract":"skill75","version":1,"kind":"artifact_meta"}')).toBeNull();
  });
});
