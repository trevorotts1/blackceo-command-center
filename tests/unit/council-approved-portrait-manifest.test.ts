import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateApprovedCouncilPortraitManifest,
  readApprovedCouncilPortraitRelease,
  CouncilPortraitManifestError,
} from '../../src/components/council/council-portrait-manifest';
import {
  COUNCIL_SEAT_ROSTER,
  COUNCIL_SEAT_IDS,
} from '../../src/components/council/council-room-types';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

type Obj = Record<string, unknown>;
function fixture(): Obj {
  const entries = COUNCIL_SEAT_ROSTER.map((seat) => {
    const variants = Object.fromEntries(
      ([
        ['room', 512, 640, 50000],
        ['detail', 800, 1000, 100000],
        ['thumb', 160, 200, 12000],
      ] as const).map(([name, width, height, bytes]) => [
        name,
        {
          src: `/council/portraits/${seat.seatId}-${name}.webp`,
          width,
          height,
          bytes,
          sha256: B,
          media_type: 'image/webp',
        },
      ]),
    );
    return {
      seat_id: seat.seatId,
      display_name: seat.displayName,
      approved_subject: seat.displayName,
      master_sha256: A,
      reviewed_master_sha256: A,
      identity_review_status: 'approved',
      identity_review_note: 'Independent reviewer examined the actual source master against this canonical seat.',
      reviewed_at: '2026-10-17T12:00:00Z',
      approved_by: 'reviewer-v1-independent',
      creation_method: 'original_generated_art',
      rights_status: 'owned_generated',
      alt_text: `Illustrated portrait of ${seat.displayName}`,
      source_note: 'Synthetic data used to exercise manifest validation only.',
      variants,
    };
  });
  return {
    schema: 'blackceo.council-portraits/v1',
    source_kind: 'reviewed_original_editorial_illustrations',
    seat_count: 9,
    room_bytes_total: 9 * 50000,
    entries,
  };
}

function altered(mutator: (m: Obj) => void): Obj {
  const original = fixture();
  mutator(original);
  return original;
}

function assertReject(doc: unknown): void {
  assert.throws(() => validateApprovedCouncilPortraitManifest(doc), CouncilPortraitManifestError);
}

test('owner-selected existing pictures require factual provenance, not fabricated rights approval', () => {
  const doc = fixture();
  doc.source_kind = 'owner_selected_existing_images';
  doc.selection_authority = 'owner';
  for (const entry of doc.entries as Obj[]) {
    entry.selected_subject = entry.display_name;
    entry.rights_status = 'unverified';
    entry.creation_method = 'existing_picture';
    for (const key of ['approved_subject', 'identity_review_status', 'identity_review_note', 'approved_by', 'reviewed_at', 'reviewed_master_sha256']) delete entry[key];
  }
  assert.equal(Object.keys(validateApprovedCouncilPortraitManifest(doc).roomSrcBySeat).length, 9);
  const entry = (doc.entries as Obj[])[0];
  entry.selected_subject = 'Les Brown';
  assertReject(doc);
  entry.selected_subject = entry.display_name;
  delete entry.source_note;
  assertReject(doc);
});

test('only exact reviewed nine-person cohort returns correct responsive room and drawer maps', () => {
  const result = validateApprovedCouncilPortraitManifest(fixture());
  assert.deepEqual(Object.keys(result.roomSrcBySeat), [...COUNCIL_SEAT_IDS]);
  for (const seat of COUNCIL_SEAT_ROSTER) {
    assert.equal(
      result.roomSrcBySeat[seat.seatId],
      `/council/portraits/${seat.seatId}-room.webp`,
    );
    assert.equal(
      result.detailSrcBySeat[seat.seatId],
      `/council/portraits/${seat.seatId}-detail.webp`,
    );
  }
});

test('Steve Harvey, a swapped portrait identity, missing seat and duplicated names all fail', () => {
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).approved_subject = 'Steve Harvey';
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).display_name = 'Steve Harvey';
  }));
  assertReject(altered((m) => {
    (m.entries as Obj[]).pop();
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[8]).seat_id = 'simon-sinek';
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).seat_id = 'steve-harvey';
  }));
});

test('missing review metadata, test-only art or changed master hash references are rejected', () => {
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).reviewed_master_sha256 = B;
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).identity_review_status = 'pending';
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).approved_by = 'synthetic-unit-test-harness';
  }));
  assertReject(altered((m) => {
    ((m.entries as Obj[])[0]).rights_status = 'test_only';
  }));
  assertReject(altered((m) => {
    m.source_kind = 'synthetic_test_fixture_not_for_release';
  }));
});

test('never load a mismatched path, an external URL, malformed hash or oversized image', () => {
  for (const change of [
    { src: '/council/portraits/td-jakes-room.webp' },
    { src: 'https://stock.invalid/steve-harvey.webp' },
    { sha256: 'not-a-hash' },
    { bytes: 9999999 },
  ]) {
    assertReject(altered((m) => {
      const first = (m.entries as Obj[])[0];
      Object.assign((first.variants as Obj).room as Obj, change);
    }));
  }
  assertReject(altered((m) => { m.room_bytes_total = 1; }));
});

test('no raw draft, empty or malformed artifact is treated as a complete illustration release', () => {
  for (const value of [
    null, [], {}, { seat_count: 9 }, { entries: [] }, 'Nate sample cast',
  ]) {
    assertReject(value);
  }
});

test('same-origin manifest lookup validates review metadata before returning portrait maps', async () => {
  let called = 0;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    called += 1;
    assert.equal(String(url), '/council/portraits/manifest.json');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    return Response.json(fixture());
  }) as typeof fetch;
  const result = await readApprovedCouncilPortraitRelease(fetcher);
  assert.equal(called, 1);
  assert.equal(result.status, 'approved');
  if (result.status === 'approved') {
    assert.equal(result.images.roomSrcBySeat['simon-sinek'], '/council/portraits/simon-sinek-room.webp');
  }
});

test('missing or malformed manifest remains visibly unavailable rather than forging images', async () => {
  const missing = await readApprovedCouncilPortraitRelease(
    (async () => new Response('not found', { status: 404 })) as typeof fetch,
  );
  assert.equal(missing.status, 'unavailable');

  const bad = await readApprovedCouncilPortraitRelease(
    (async () => Response.json(altered((m) => {
      ((m.entries as Obj[])[0]).approved_subject = 'Steve Harvey';
    }))) as typeof fetch,
  );
  assert.equal(bad.status, 'unavailable');
  const interrupted = await readApprovedCouncilPortraitRelease(
    (async () => { throw new Error('network offline'); }) as typeof fetch,
  );
  assert.equal(interrupted.status, 'unavailable');
});


test('explicit test-only markers fail closed at cohort and entry level', () => {
  for (const value of [true, 'true', 'false', 0, null, [], {}]) {
    assertReject(altered((m) => { m.test_only = value; }));
    assertReject(altered((m) => { (m.entries as Obj[])[0].test_only = value; }));
  }
  const production = altered((m) => {
    m.test_only = false;
    for (const entry of m.entries as Obj[]) entry.test_only = false;
  });
  assert.equal(Object.keys(validateApprovedCouncilPortraitManifest(production).roomSrcBySeat).length, 9);
});

test('whitespace cannot disguise the reserved synthetic reviewer', () => {
  for (const value of [' synthetic-unit-test-harness ', '\t\nsynthetic-unit-test-harness\r', ['reviewer-v1-independent'], {}]) {
    assertReject(altered((m) => { (m.entries as Obj[])[0].approved_by = value; }));
  }
});

test('rights status must be a supported string rather than a coercible value', () => {
  for (const value of [['owned_generated'], ['licensed_original'], { toString: () => 'owned_original' }, null, true]) {
    assertReject(altered((m) => { (m.entries as Obj[])[0].rights_status = value; }));
  }
});

test('UTC review timestamps reject normalized calendar dates and unsupported clock forms', () => {
  for (const value of [
    '2026-02-30T12:00:00Z', '2026-02-29T12:00:00Z', '1900-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z', '0000-01-01T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-10-17T24:01:00Z', '2026-10-17T24:00:01Z', '2026-10-17T24:00:00.1Z', '9999-12-31T24:00:00Z',
    '2026-10-17T12:60:00Z', '2026-10-17T12:00:60Z', '2026-10-17T12:00Z',
    '2026-10-17T12:00:00+00:00', '2026-10-17T12:00:00.Z', ['2026-10-17T12:00:00Z'],
  ]) {
    assertReject(altered((m) => { (m.entries as Obj[])[0].reviewed_at = value; }));
  }
});

test('real calendar dates and producer-supported fractional UTC timestamps remain compatible', () => {
  for (const value of ['0001-01-01T00:00:00Z', '2000-02-29T23:59:59Z', '2024-02-29T12:00:00.123456789Z', '2026-10-17T12:00:00.1Z', '2026-10-17T24:00:00Z', '2026-10-17T24:00:00.000Z']) {
    const manifest = altered((m) => { (m.entries as Obj[])[0].reviewed_at = value; });
    assert.equal(Object.keys(validateApprovedCouncilPortraitManifest(manifest).roomSrcBySeat).length, 9);
  }
});

test('malformed review metadata remains unavailable through the release loader', async () => {
  for (const mutate of [
    (m: Obj) => { m.test_only = true; },
    (m: Obj) => { (m.entries as Obj[])[0].test_only = true; },
    (m: Obj) => { (m.entries as Obj[])[0].approved_by = ' synthetic-unit-test-harness '; },
    (m: Obj) => { (m.entries as Obj[])[0].reviewed_at = '2026-02-30T12:00:00Z'; },
    (m: Obj) => { (m.entries as Obj[])[0].rights_status = ['owned_generated']; },
  ]) {
    const result = await readApprovedCouncilPortraitRelease(
      (async () => Response.json(altered(mutate))) as typeof fetch,
    );
    assert.equal(result.status, 'unavailable');
  }
});
