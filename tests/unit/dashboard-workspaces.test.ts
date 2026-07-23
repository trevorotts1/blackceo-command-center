import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectProducerCardSlugs,
  type ProducerBoardCandidate,
  type EngineDbPresence,
} from '../../src/lib/dashboard-workspaces';

const ANTHOLOGY: ProducerBoardCandidate = { slug: 'anthology' };
const PODCAST: ProducerBoardCandidate = { slug: 'podcast' };
const CANDIDATES: ProducerBoardCandidate[] = [ANTHOLOGY, PODCAST];

describe('selectProducerCardSlugs (no engine-DB map)', () => {
  it('returns degraded:true when status is error', () => {
    const r = selectProducerCardSlugs('error', new Set(), CANDIDATES);
    assert.equal(r.degraded, true);
  });

  it('returns only workspace-present slugs when status is ok', () => {
    const r = selectProducerCardSlugs('ok', new Set(['podcast']), CANDIDATES);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, ['podcast']);
    assert.deepEqual(r.notInstalled, []);
  });

  it('returns empty when no workspace slugs are present', () => {
    const r = selectProducerCardSlugs('ok', new Set(), CANDIDATES);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, []);
    assert.deepEqual(r.notInstalled, []);
  });
});

describe('selectProducerCardSlugs (with engine-DB map — U018)', () => {
  const db: EngineDbPresence = { podcast: false, anthology: true };

  it('puts a workspace-present slug with engine DB absent into notInstalled', () => {
    const r = selectProducerCardSlugs('ok', new Set(['podcast']), CANDIDATES, db);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, []);
    assert.deepEqual(r.notInstalled, ['podcast']);
  });

  it('puts a workspace-present slug with engine DB present into slugs (live)', () => {
    const r = selectProducerCardSlugs('ok', new Set(['anthology']), CANDIDATES, db);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, ['anthology']);
    assert.deepEqual(r.notInstalled, []);
  });

  it('splits mixed slugs correctly (one live, one not-installed)', () => {
    const r = selectProducerCardSlugs('ok', new Set(['anthology','podcast']), CANDIDATES, db);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, ['anthology']);
    assert.deepEqual(r.notInstalled, ['podcast']);
  });

  it('returns empty both arrays when no workspace slugs present', () => {
    const r = selectProducerCardSlugs('ok', new Set(), CANDIDATES, db);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, []);
    assert.deepEqual(r.notInstalled, []);
  });

  it('still returns degraded:true on error, regardless of db map', () => {
    const r = selectProducerCardSlugs('error', new Set(['podcast']), CANDIDATES, db);
    assert.equal(r.degraded, true);
  });

  it('treats every workspace slug as live when engine-DB map is null (loading)', () => {
    const r = selectProducerCardSlugs('ok', new Set(['anthology','podcast']), CANDIDATES, null);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.slugs, ['anthology','podcast']);
    assert.deepEqual(r.notInstalled, []);
  });
});
