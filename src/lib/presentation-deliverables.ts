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
  // FIX 3: the guide floor is NOT the flat 51_200 below — that number was
  // calibrated to the 34-slide reference deck and a 12-slide deck cannot pass
  // it honestly. The static min_bytes here stays as the no-context default
  // (34-slide calibration) so the table shape is unchanged; every call site
  // that knows the deck's slide count must use guideFloor(slideCount) instead.
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

// ── FIX 3: one presenter-guide floor, scaled to the deck ─────────────────────
// MASTER Part 8 FIX 3: the flat 51,200-byte guide floor was calibrated to the
// 34-slide reference deck, so a 12-slide deck (whose honest guide is ~21 KB)
// could never pass — it re-ran P8.2-GUIDE 62 times on September 1. The floor
// now scales with the deck: guide_floor(n) = max(1600 × n, 12000), the SAME
// formula the engine side lives under (openclaw-onboarding
// presentation_job/deliverable_floors.py guide_floor). One helper, both repos.
//
//   guideFloor(12) = 19_200   guideFloor(34) = 54_400   guideFloor(60) = 96_000

/** Per-slide guide floor component, bytes per slide (matches the engine). */
export const GUIDE_FLOOR_PER_SLIDE = 1_600;
/** Minimum guide floor, bytes — for very small decks (matches the engine). */
export const GUIDE_FLOOR_MINIMUM = 12_000;
/**
 * Legacy flat floor (the 34-slide calibration). Returned when the deck's
 * slide count is unknown so the gate never weakens on missing context.
 */
export const GUIDE_FLOOR_LEGACY = 51_200;

/**
 * The presenter-guide byte floor for a deck of `n` slides:
 * max(1600 × n, 12000). A null/undefined/negative slide count has no deck
 * context — the legacy flat floor applies so the gate only ever scales DOWN
 * when the deck size is actually known, never by accident.
 */
export function guideFloor(slideCount?: number | null): number {
  if (typeof slideCount !== 'number' || !Number.isFinite(slideCount) || slideCount < 0) {
    return GUIDE_FLOOR_LEGACY;
  }
  return Math.max(Math.round(slideCount) * GUIDE_FLOOR_PER_SLIDE, GUIDE_FLOOR_MINIMUM);
}

/**
 * Effective guide floor for a task row that may carry the deck's slide count
 * (tasks.slide_count, Migration 130 — nullable on every non-presentation
 * task). Accepts `unknown` because the value comes straight off a DB row.
 */
export function guideFloorForTask(slideCount: unknown): number {
  if (typeof slideCount !== 'number' || !Number.isFinite(slideCount) || slideCount <= 0) {
    return GUIDE_FLOOR_LEGACY;
  }
  return guideFloor(slideCount);
}
