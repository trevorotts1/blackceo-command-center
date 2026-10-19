/**
 * Gap F (UI half) - DeliverablesList offered an in-browser preview only for
 * html/images; every other file (PRESENTER-GUIDE.pdf, Deck-FINAL.pptx, an mp3)
 * had only "Reveal in Finder", which opens Finder on the SERVER box, so a web
 * client got a dead button.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-gap-f-deliverables-render.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

import { DeliverablesList } from '../../src/components/DeliverablesList';

afterEach(() => cleanup());

const mk = (id: string, deliverable_type: string, title: string, p: string) => ({
  id, task_id: 't1', deliverable_type, title, path: p, created_at: '2026-10-01T10:00:00.000Z',
});

describe('DeliverablesList - every file deliverable is reachable from a browser (gap F)', () => {
  it('previews pdf/audio inline, downloads a pptx, and gives URLs neither', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        mk('d1', 'file', 'Guide', '/p/PRESENTER-GUIDE.pdf'),
        mk('d2', 'file', 'Deck', '/p/Deck-FINAL.pptx'),
        mk('d3', 'artifact', 'Theme song', '/p/Song.MP3'),
        mk('d4', 'url', 'Live page', 'https://example.com/page'),
      ],
    })) as unknown as typeof fetch;

    render(<DeliverablesList taskId="t1" />);
    await waitFor(() => screen.getByText('Guide'));

    const card = (title: string) => screen.getByText(title).closest('.flex.gap-3') as HTMLElement;

    // pdf: inline preview + download
    expect(within(card('Guide')).queryByTitle('Preview in browser')).not.toBeNull();
    const pdfDl = within(card('Guide')).getByLabelText('Download Guide') as HTMLAnchorElement;
    expect(pdfDl.getAttribute('href')).toBe(
      `/api/files/preview?path=${encodeURIComponent('/p/PRESENTER-GUIDE.pdf')}&download=1`,
    );

    // pptx: a browser cannot show it, so download only - no dead preview button
    expect(within(card('Deck')).queryByTitle('Preview in browser')).toBeNull();
    expect(within(card('Deck')).getByLabelText('Download Deck').getAttribute('href')).toContain('download=1');

    // mp3 (any case, artifact type): previews and downloads
    expect(within(card('Theme song')).queryByTitle('Preview in browser')).not.toBeNull();
    expect(within(card('Theme song')).queryByLabelText('Download Theme song')).not.toBeNull();

    // a URL deliverable is already a real link: no download, no preview
    expect(within(card('Live page')).queryByLabelText('Download Live page')).toBeNull();
    expect(within(card('Live page')).queryByTitle('Preview in browser')).toBeNull();
  });
});
