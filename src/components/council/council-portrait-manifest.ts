/**
 * WER-017: consume a complete nine-person portrait release.
 *
 * The build script (scripts/council/build_portrait_assets.py) constructs the
 * release manifest after asset/rights sign-off. Existing owner-selected
 * pictures may instead retain unverified rights without claiming sign-off.
 * This validator is the
 * corresponding zero-side-effect UI trust boundary. A draft/test-only,
 * incomplete, mixed-person or tampered cohort returns no portrait maps.
 *
 * It verifies manifest structure, immutable names and hash references;
 * It does not establish facial resemblance, authorship or license ownership.
 */
import {
  COUNCIL_SEAT_IDS,
  COUNCIL_SEAT_ROSTER,
  type CouncilSeatId,
} from './council-room-types';

export interface ApprovedCouncilPortraitMaps {
  roomSrcBySeat: Readonly<Record<CouncilSeatId, string>>;
  detailSrcBySeat: Readonly<Record<CouncilSeatId, string>>;
  thumbSrcBySeat: Readonly<Record<CouncilSeatId, string>>;
}

export class CouncilPortraitManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilPortraitManifestError';
  }
}

type Data = Record<string, unknown>;
const variantSpecs = {
  room: { width: 512, height: 640, maxBytes: 200 * 1024 },
  detail: { width: 800, height: 1000, maxBytes: 350 * 1024 },
  thumb: { width: 160, height: 200, maxBytes: 30 * 1024 },
} as const;
const rights = new Set(['owned_original', 'licensed_original', 'owned_generated']);
const HASH = /^[a-f0-9]{64}$/;

function fail(detail: string): never {
  throw new CouncilPortraitManifestError('Council portrait release refused: ' + detail);
}

function object(value: unknown): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('expected a JSON object');
  }
  return value as Data;
}

function goodString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

// Match the producer's UTC timestamp grammar without Date.parse normalizing
// impossible dates (for example February 30) into a different calendar day.
function isUtcReviewTimestamp(value: unknown): boolean {
  if (!goodString(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Python 3.14's producer also accepts ISO end-of-day midnight. Preserve
  // that existing consumer behavior, but never normalize an impossible date
  // or a non-midnight 24th hour. Fractional seconds must all be zero there.
  const endOfDay = hour === 24 && minute === 0 && second === 0 &&
    (!match[7] || /^\.0+$/.test(match[7])) && !(year === 9999 && month === 12 && day === 31);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= monthDays[month - 1] && (hour <= 23 || endOfDay) && minute <= 59 && second <= 59;
}

// Older producer manifests omit this marker. If supplied it must explicitly
// be false; true or a coerced/string value can never become a release.
function hasProductionMarker(record: Data): boolean {
  return !('test_only' in record) || record.test_only === false;
}

export function validateApprovedCouncilPortraitManifest(raw: unknown): ApprovedCouncilPortraitMaps {
  const manifest = object(raw);
  // Owner-selected existing pictures carry factual provenance, not invented
  // illustration authorship, identity-review results or license approval.
  const ownerSelected = manifest.source_kind === 'owner_selected_existing_images' &&
    manifest.selection_authority === 'owner';
  if (
    !hasProductionMarker(manifest) ||
    manifest.schema !== 'blackceo.council-portraits/v1' ||
    (!ownerSelected && manifest.source_kind !== 'reviewed_original_editorial_illustrations') ||
    manifest.seat_count !== COUNCIL_SEAT_IDS.length ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== COUNCIL_SEAT_IDS.length
  ) {
    fail('not a complete nine-seat portrait cohort');
  }
  const room = {} as Record<CouncilSeatId, string>;
  const detail = {} as Record<CouncilSeatId, string>;
  const thumb = {} as Record<CouncilSeatId, string>;
  let sumRoomBytes = 0;
  const seen = new Set<string>();

  for (const rawEntry of manifest.entries) {
    const entry = object(rawEntry);
    if (!goodString(entry.seat_id) ||
        !COUNCIL_SEAT_IDS.some((seat) => seat === entry.seat_id) ||
        seen.has(entry.seat_id)) {
      fail('unknown, duplicated or substituted advisor seat');
    }
    const seatId = entry.seat_id as CouncilSeatId;
    const identity = COUNCIL_SEAT_ROSTER.find((seat) => seat.seatId === seatId);
    if (
      !hasProductionMarker(entry) ||
      !identity ||
      entry.display_name !== identity.displayName ||
      !goodString(entry.alt_text) ||
      !goodString(entry.source_note) ||
      !goodString(entry.creation_method) ||
      typeof entry.rights_status !== 'string' ||
      (!rights.has(entry.rights_status) && !(ownerSelected && entry.rights_status === 'unverified')) ||
      !isHash(entry.master_sha256) ||
      (ownerSelected ? entry.selected_subject !== identity.displayName : (
        entry.approved_subject !== identity.displayName ||
        entry.identity_review_status !== 'approved' ||
        !goodString(entry.identity_review_note) ||
        !goodString(entry.approved_by) ||
        entry.approved_by.trim() === 'synthetic-unit-test-harness' ||
        !isUtcReviewTimestamp(entry.reviewed_at) ||
        !isHash(entry.reviewed_master_sha256) ||
        entry.reviewed_master_sha256 !== entry.master_sha256
      ))
    ) {
      fail('invalid review metadata or wrong-subject portrait for ' + seatId);
    }
    const variants = object(entry.variants);
    if (
      Object.keys(variants).length !== 3 ||
      !Object.keys(variantSpecs).every((name) => name in variants)
    ) {
      fail('incomplete or additional art variants for ' + seatId);
    }
    for (const name of Object.keys(variantSpecs) as Array<keyof typeof variantSpecs>) {
      const variant = object(variants[name]);
      const expected = variantSpecs[name];
      const path = '/council/portraits/' + seatId + '-' + name + '.webp';
      if (
        variant.src !== path ||
        variant.width !== expected.width ||
        variant.height !== expected.height ||
        variant.media_type !== 'image/webp' ||
        !Number.isSafeInteger(variant.bytes) ||
        (variant.bytes as number) <= 0 ||
        (variant.bytes as number) > expected.maxBytes ||
        !isHash(variant.sha256)
      ) {
        fail('wrong, unsupported or oversized ' + name + ' portrait for ' + seatId);
      }
      if (name === 'room') {
        room[seatId] = path;
        sumRoomBytes += variant.bytes as number;
      } else if (name === 'detail') {
        detail[seatId] = path;
      } else {
        thumb[seatId] = path;
      }
    }
    seen.add(seatId);
  }
  if (
    seen.size !== COUNCIL_SEAT_IDS.length ||
    !COUNCIL_SEAT_IDS.every((seat) => seen.has(seat)) ||
    !Number.isSafeInteger(manifest.room_bytes_total) ||
    manifest.room_bytes_total !== sumRoomBytes ||
    sumRoomBytes > 1800 * 1024
  ) {
    fail('wrong roster or total portrait payload size');
  }
  return {
    roomSrcBySeat: room,
    detailSrcBySeat: detail,
    thumbSrcBySeat: thumb,
  };
}

/**
 * This is intentionally a SAME-ORIGIN, READ-ONLY asset lookup. The host
 * serves a vetted manifest only after the complete nine-image cohort has
 * shipped. Missing/invalid art is a named unavailable state, never a
 * silently fabricated portrait. The mounted page may preserve accessible
 * medallions until it can safely adopt these URLs.
 */
export type CouncilPortraitRelease =
  | { status: 'approved'; images: ApprovedCouncilPortraitMaps }
  | { status: 'unavailable'; reason: string };

export async function readApprovedCouncilPortraitRelease(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CouncilPortraitRelease> {
  try {
    const response = await fetcher('/council/portraits/manifest.json', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      return { status: 'unavailable', reason: 'No completed Council portrait asset cohort is published.' };
    }
    const body: unknown = await response.json();
    return {
      status: 'approved',
      images: validateApprovedCouncilPortraitManifest(body),
    };
  } catch {
    return {
      status: 'unavailable',
      reason: 'The Council portrait manifest is absent, unapproved or malformed.',
    };
  }
}
