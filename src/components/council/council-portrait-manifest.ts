/**
 * WER-017: consume only a COMPLETE, approved nine-person portrait release.
 *
 * The build script (scripts/council/build_portrait_assets.py) constructs the
 * release manifest after asset/rights sign-off. This validator is the
 * corresponding zero-side-effect UI trust boundary. A draft/test-only,
 * incomplete, mixed-person or tampered cohort returns no portrait maps.
 *
 * It verifies manifest structure, immutable names and hash references;
 * facial resemblance itself still REQUIRES independent human/art QC.
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

export function validateApprovedCouncilPortraitManifest(raw: unknown): ApprovedCouncilPortraitMaps {
  const manifest = object(raw);
  if (
    manifest.schema !== 'blackceo.council-portraits/v1' ||
    manifest.source_kind !== 'reviewed_original_editorial_illustrations' ||
    manifest.seat_count !== COUNCIL_SEAT_IDS.length ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== COUNCIL_SEAT_IDS.length
  ) {
    fail('not a complete, approved nine-seat original illustration cohort');
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
      !identity ||
      entry.display_name !== identity.displayName ||
      entry.approved_subject !== identity.displayName ||
      entry.identity_review_status !== 'approved' ||
      !goodString(entry.identity_review_note) ||
      !goodString(entry.approved_by) ||
      entry.approved_by === 'synthetic-unit-test-harness' ||
      !goodString(entry.reviewed_at) ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(entry.reviewed_at) ||
      !Number.isFinite(Date.parse(entry.reviewed_at)) ||
      !goodString(entry.alt_text) ||
      !goodString(entry.source_note) ||
      !goodString(entry.creation_method) ||
      !rights.has(String(entry.rights_status)) ||
      !isHash(entry.master_sha256) ||
      !isHash(entry.reviewed_master_sha256) ||
      entry.reviewed_master_sha256 !== entry.master_sha256
    ) {
      fail('unreviewed, unsigned or wrong-subject portrait for ' + seatId);
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
