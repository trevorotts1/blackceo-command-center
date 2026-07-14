/**
 * filterModels (U60 / JM-U63f) — PURE, framework-free so the QC unit-test
 * fixture (spec acceptance item 7: "ModelPicker fixture containing an
 * Anthropic-prefixed registry row renders WITHOUT it") can import and assert
 * against it directly, without mounting the component.
 *
 * Client skills never use Anthropic models (fleet-wide sovereignty doctrine).
 * This is the SAME `isForbidden()` the onboarding Python selector and the
 * settings write/read path already use — kept at byte parity, never
 * re-implemented here.
 */
import { isForbidden } from '@/lib/model-selector';
import type { ModelOption } from './types';

export function filterModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => !isForbidden(m.model_id));
}
