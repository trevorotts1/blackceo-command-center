/**
 * P2-02 — the SOP link in the task modal must NOT be a dead control.
 *
 * TaskOverviewPanels.tsx renders the attached SOP as a link
 * `href="/sops/<id>"`. Before this fix there was NO page route behind that
 * path — only `/sops/proposals` existed, and there is no next.config rewrite —
 * so clicking the SOP name 404'd. That is a dead control, violating P2-02 step 6
 * / QC (e) "zero dead controls".
 *
 * FAIL-FIRST: against the pre-fix tree `src/app/sops/[id]/page.tsx` does not
 * exist, so the "route file exists" assertion fails. With the fix (the SOP detail
 * page) it passes.
 *
 * The test couples to the component: it confirms the SOP panel still links to the
 * `/sops/<id>` route AND that a Next.js page route resolves that exact path — so
 * if either the link or the page is later removed/renamed, the 404 regression is
 * caught here rather than by a user clicking a dead link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');

test('the task-modal SOP panel links SOPs to the /sops/[id] route', () => {
  const panelSrc = fs.readFileSync(
    path.join(repoRoot, 'src', 'components', 'TaskOverviewPanels.tsx'),
    'utf-8',
  );
  // The SOP panel renders an anchor whose href is the /sops/<id> detail route.
  assert.ok(
    /href=\{`\/sops\/\$\{/.test(panelSrc),
    'TaskSopPanel must link the SOP to the /sops/<id> detail route',
  );
});

test('the /sops/[id] page route the SOP link targets actually exists (no 404 dead control)', () => {
  const pageFile = path.join(repoRoot, 'src', 'app', 'sops', '[id]', 'page.tsx');
  assert.ok(
    fs.existsSync(pageFile),
    `the SOP link target /sops/[id] must have a page route at ${pageFile} — otherwise the modal's SOP link 404s`,
  );
  // It must be a real Next.js page (a default-exported component), not an empty stub.
  const pageSrc = fs.readFileSync(pageFile, 'utf-8');
  assert.ok(
    /export default function/.test(pageSrc),
    'the /sops/[id] page must default-export a page component',
  );
});
