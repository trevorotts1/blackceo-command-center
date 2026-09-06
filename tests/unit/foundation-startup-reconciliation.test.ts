import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb, closeDb, run, queryOne } from '../../src/lib/db';
import { reseedWorkspacesFromConfig } from '../../src/lib/db/migrations';
import { verifyStandardFoundation } from '../../src/lib/interview/foundation-verification';

const root = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'company');
Object.assign(process.env, { MC_COMPANY_ID: 'foundation-owner', ZERO_HUMAN_COMPANY_DIR: root });
process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON = JSON.stringify({ 'foundation-owner': {
  companyRoot: root, companyConfig: path.join(root, 'company-config.json'),
  companySlug: 'foundation-owner', personaCatalog: path.join(root, 'catalog.json'),
} });

test('actual startup reseed CEO alias preserves receipt; foreign, archived or unrelated rows never qualify', () => {
  const db = getDb(); // Actual schema/migrations create bootstrap engine rows.
  try {
    fs.mkdirSync(path.join(root, 'departments/master-orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(root, 'company-config.json'), JSON.stringify({
      id: 'foundation-owner', companyId: 'foundation-owner', slug: 'foundation-owner',
      companySlug: 'foundation-owner', name: 'Foundation Fixture', companyName: 'Foundation Fixture',
    }));
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ personas: { fixture: { name: 'Fixture' } } }));
    // Actual standard prebuild manifest uses dept-ceo/ceo while its receipt and
    // artifact directory retain the canonical master-orchestrator identity.
    fs.writeFileSync(path.join(root, 'departments.json'), JSON.stringify([
      { id: 'dept-ceo', slug: 'ceo', name: 'CEO', isCeo: true },
    ]));
    fs.writeFileSync(path.join(root, 'departments/master-orchestrator/SOUL.md'), 'Canonical fixture CEO foundation');
    run("INSERT INTO companies(id,name,slug) VALUES('foundation-owner','Foundation Fixture','foundation-owner')");
    run("INSERT INTO workspaces(id,name,slug,company_id) VALUES('master-orchestrator','CEO','master-orchestrator','foundation-owner')");
    const artifacts = ['departments.json', 'departments/master-orchestrator/SOUL.md'].map(file => ({
      path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
    }));
    const state = { companyId: 'foundation-owner', buildId: 'fixture-build', standardPrebuild: {
      status: 'done', prebuiltDepartments: ['master-orchestrator'], foundationVerification: {
        version: 1, status: 'verified', companyId: 'foundation-owner', buildId: 'fixture-build',
        artifacts, workspaceSlugs: ['master-orchestrator'],
      },
    } };
    assert.deepEqual(verifyStandardFoundation(state), { ready: true, missing: [] });
    assert.equal(reseedWorkspacesFromConfig(db, { force: true }).outcome, 'seeded');
    assert.equal(queryOne<{slug:string}>("SELECT slug FROM workspaces WHERE id='master-orchestrator'")!.slug, 'ceo');
    assert.deepEqual(verifyStandardFoundation(state), { ready: true, missing: [] });
    assert.equal(reseedWorkspacesFromConfig(db, { force: true }).outcome, 'seeded');
    assert.equal(verifyStandardFoundation(state).ready, true, 'startup replay stays ready');
    run("UPDATE workspaces SET company_id='default' WHERE id='master-orchestrator'");
    assert.ok(verifyStandardFoundation(state).missing.includes('foundation_board_reconciliation'));
    run("UPDATE workspaces SET company_id='foundation-owner',archived_at='2026-09-06' WHERE id='master-orchestrator'");
    assert.equal(verifyStandardFoundation(state).ready, false);
    run("UPDATE workspaces SET archived_at=NULL,slug='unrelated-team' WHERE id='master-orchestrator'");
    assert.equal(verifyStandardFoundation(state).ready, false, 'an ID alone cannot mask unrelated department identity');
  } finally { closeDb(); }
});
