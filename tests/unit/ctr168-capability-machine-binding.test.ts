/**
 * CTR-168 — capability-route machine binding and the consult statement
 * (unexecuted here; Trevor owns the test run).
 *
 * Narrow regression for the two non-trivial patterns in this lane:
 *   1. the capability routes require the exact operation-level machine
 *      binding: 'capability_read' for GET and 'capability_write' for POST.
 *      A bearer alone is authentication, not authorization. No binding,
 *      a binding naming only the other operation, or a missing
 *      x-expected-installation-id pin is refused COUNCIL_MACHINE_BINDING;
 *   2. a consult export states, in print/PDF and Markdown, that no council
 *      debate happened. It never reads as a nine-seat or nine-round debate,
 *      and the print section numbering stays 1..5.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *   --test tests/unit/ctr168-capability-machine-binding.test.ts
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { machineAuthFor } from '../../src/lib/council/api/foundation';
import type { CouncilPrincipal } from '../../src/lib/council/auth';
import { CouncilAuthError } from '../../src/lib/council/auth';
import {
  CONSULT_NO_DEBATE_NOTE,
  renderPrintHtml,
} from '../../src/lib/council/report-print-template';
import { renderMarkdown } from '../../src/lib/council/report-downloads';

const ENV_KEY = 'MC_COUNCIL_MACHINE_BINDINGS_JSON';
let savedBindingEnv: string | undefined;

before(() => {
  savedBindingEnv = process.env[ENV_KEY];
});

after(() => {
  if (savedBindingEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedBindingEnv;
});

function installBinding(operations: string[]): void {
  process.env[ENV_KEY] = JSON.stringify([
    {
      installation_id: 'install-a',
      company_id: 'company-a',
      operations,
    },
  ]);
}

function principal(channel: 'machine' | 'browser'): CouncilPrincipal {
  return {
    subject: channel === 'machine' ? 'operator:api' : 'owner:person',
    tenantKind: 'client',
    channel,
    supportAccess: false,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: 'install-a',
      owner_subject: null,
    },
    tenant: {} as CouncilPrincipal['tenant'],
  };
}

function request(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

const pin = { 'x-expected-installation-id': 'install-a' };

function isMachineBindingRefusal(error: unknown): boolean {
  return error instanceof CouncilAuthError && error.code === 'COUNCIL_MACHINE_BINDING';
}

test('capability binding is refused when the host configured none', () => {
  delete process.env[ENV_KEY];
  assert.throws(
    () => machineAuthFor(request(pin), principal('machine'), 'capability_read'),
    isMachineBindingRefusal,
  );
  assert.throws(
    () => machineAuthFor(request(pin), principal('machine'), 'capability_write'),
    isMachineBindingRefusal,
  );
});

test('read and write are separate operations, never implied by each other', () => {
  installBinding(['capability_read']);
  assert.doesNotThrow(() =>
    machineAuthFor(request(pin), principal('machine'), 'capability_read'),
  );
  assert.throws(
    () => machineAuthFor(request(pin), principal('machine'), 'capability_write'),
    isMachineBindingRefusal,
  );

  installBinding(['capability_write']);
  assert.doesNotThrow(() =>
    machineAuthFor(request(pin), principal('machine'), 'capability_write'),
  );
  assert.throws(
    () => machineAuthFor(request(pin), principal('machine'), 'capability_read'),
    isMachineBindingRefusal,
  );

  // A broad session permission does not stand in for a capability operation.
  installBinding(['read', 'run', 'execute', 'export']);
  assert.throws(
    () => machineAuthFor(request(pin), principal('machine'), 'capability_read'),
    isMachineBindingRefusal,
  );
});

test('a bound machine caller must still pin the installation', () => {
  installBinding(['capability_read', 'capability_write']);
  assert.throws(
    () => machineAuthFor(request(), principal('machine'), 'capability_write'),
    isMachineBindingRefusal,
  );
  assert.throws(
    () =>
      machineAuthFor(
        request({ 'x-expected-installation-id': 'install-b' }),
        principal('machine'),
        'capability_write',
      ),
    isMachineBindingRefusal,
  );
  assert.doesNotThrow(() =>
    machineAuthFor(request(pin), principal('machine'), 'capability_write'),
  );
});

test('browser principals keep their own authorization path', () => {
  delete process.env[ENV_KEY];
  assert.equal(
    machineAuthFor(request(), principal('browser'), 'capability_read'),
    undefined,
  );
  assert.equal(
    machineAuthFor(request(), principal('browser'), 'capability_write'),
    undefined,
  );
});

function consultReportModel(): Record<string, unknown> {
  return {
    verdict_block: { revision: 1 },
    summary: {},
    readiness: {},
    brief: {},
    question_and_context: { unknowns: {} },
    your_tools: {},
    provenance: {},
    consult: {
      seat_id: 'advisor-1',
      display_name: 'Seat One',
      label: 'Consultant',
      answer: 'Consider the smaller commitment first.',
      assumptions: ['The budget is fixed.'],
      limits: ['One seat only.'],
      next_step: 'Confirm the budget.',
    },
  };
}

test('consult exports state the absence of a council debate', () => {
  const model = consultReportModel();
  const printHtml = renderPrintHtml(model);
  const markdown = renderMarkdown(model);

  assert.ok(printHtml.includes(CONSULT_NO_DEBATE_NOTE));
  assert.ok(markdown.includes(CONSULT_NO_DEBATE_NOTE));

  // No debate artifact is printed for a consult.
  assert.equal(printHtml.includes('Rounds saved:'), false);
  assert.equal(markdown.includes('Rounds saved:'), false);

  // Section numbering is unchanged: 1..5, each exactly once.
  for (const number of ['1', '2', '3', '4', '5']) {
    const occurrences = printHtml.split(`<span class="sec-n">${number}</span>`).length - 1;
    assert.equal(occurrences, 1, `section ${number} must print once`);
  }
});
