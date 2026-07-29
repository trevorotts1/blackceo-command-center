/**
 * U063: the nine artifacts build_deck.py's DELIVERABLES_REQUIRED (:811-889)
 * declares. Nine was measured by parsing that file's syntax tree, not by eye.
 * Order is the producer's order and is the order the panel renders.
 *
 * Source: openclaw-onboarding @ 833fd5f7, branch fix/skill35-image-rendering
 * File: 23-ai-workforce-blueprint/templates/role-library/presentations/scripts/build_deck.py
 */

export interface PresentationArtifact {
  key: string;
  filename: string;
  label: string;
  min_bytes: number;
}

export const PRESENTATION_ARTIFACTS: readonly PresentationArtifact[] = [
  { key: 'deck_pptx',        filename: '{deck_slug}-FINAL.pptx',             label: 'Deck (PPTX)',             min_bytes: 1_048_576 },
  { key: 'deck_pdf',         filename: '{deck_slug}-FINAL.pdf',              label: 'Deck (PDF)',              min_bytes: 51_200 },
  { key: 'guide_pdf',        filename: 'PRESENTER-GUIDE.pdf',                label: 'Presenter Guide (PDF)',   min_bytes: 51_200 },
  { key: 'speech_md',        filename: 'PRESENTERS-SPEECH.md',               label: 'Speech (Markdown)',       min_bytes: 2_048 },
  { key: 'speech_pdf',       filename: 'PRESENTERS-SPEECH.pdf',              label: 'Speech (PDF)',            min_bytes: 3_000 },
  { key: 'speech_fish_md',   filename: 'PRESENTERS-SPEECH-FISH-TAGGED.md',   label: 'Speech (Fish-Tagged MD)', min_bytes: 2_048 },
  { key: 'audio_mp3',        filename: 'PRESENTER-AUDIO.mp3',                label: 'Audio (MP3)',             min_bytes: 512_000 },
  { key: 'infographic_png',  filename: 'infographic.png',                    label: 'Infographic (PNG)',       min_bytes: 102_400 },
  { key: 'teleprompter_html',filename: 'presenter-teleprompter.html',        label: 'Teleprompter (HTML)',     min_bytes: 20_000 },
];

// The seven keys build_deck.py's DELIVERABLE_MAGIC (:8114-8128) type-verifies.
// speech_md and speech_fish_md are DELIBERATELY absent — that file says so:
// "plain/tagged markdown has no magic signature, so md stays size-only".
export const MAGIC_VERIFIED_KEYS: readonly string[] = [
  'deck_pptx',
  'deck_pdf',
  'guide_pdf',
  'speech_pdf',
  'audio_mp3',
  'infographic_png',
  'teleprompter_html',
];

export const SIZE_ONLY_KEYS: readonly string[] = ['speech_md', 'speech_fish_md'];

export const ARTIFACT_KEY_SET: ReadonlySet<string> = new Set(
  PRESENTATION_ARTIFACTS.map((a) => a.key),
);

export const MAGIC_VERIFIED_SET: ReadonlySet<string> = new Set(MAGIC_VERIFIED_KEYS);
export const SIZE_ONLY_SET: ReadonlySet<string> = new Set(SIZE_ONLY_KEYS);

/** Resolve a concrete filename for an artifact given the deck slug. */
export function resolveFilename(artifact: PresentationArtifact, deckSlug?: string | null): string {
  if (deckSlug && artifact.filename.includes('{deck_slug}')) {
    return artifact.filename.replace(/\{deck_slug\}/g, deckSlug);
  }
  return artifact.filename;
}
