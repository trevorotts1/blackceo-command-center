/**
 * Council scoped settings service (CWE-050; directive Sections
 * 17.2, 15.6).
 *
 * The settings endpoints store "validated nonsecret preferences"
 * for one trusted scope (tenant, company, installation) "without
 * touching global provider config". The operative settings today are
 * the canonical Section 15.6 defaults (DEFAULT_COUNCIL_SETTINGS,
 * which the CWE-049 admission path reads directly); this service is
 * the persistence layer the endpoints bind:
 *
 * - GET returns the stored settings for the scope, or the canonical
 *   defaults verbatim when nothing was stored (source:
 *   'canonical_defaults', revision 0). It never invents values.
 * - PATCH validates the submitted record against the canonical
 *   CouncilSettings schema (a strict object: unknown keys fail),
 *   requires the caller's expected revision to match the stored
 *   revision (stale writers conflict, T058), and persists the new
 *   record with the revision incremented.
 *
 * Storage: one JSON record per scope in a `council-settings`
 * directory beside the resolved Command Center database file (the
 * council data profile location), written atomically (temp file +
 * rename) with mode 0600. No database migration is needed or taken:
 * the council schema is frozen under the integrator's migration
 * allocation rule, and settings are profile data, not session state.
 * A stored record that fails validation on read is a hard error,
 * never a silent fall back to defaults.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDbPath } from '../db';
import {
  canonicalStringify,
  DEFAULT_COUNCIL_SETTINGS,
  validateCouncilSettings,
  type CouncilSettings,
} from './contracts';
import { CouncilApiError } from './api/errors';

export interface CouncilSettingsScope {
  tenant_id: string;
  company_id: string;
  installation_id: string;
}

export interface CouncilSettingsView {
  scope: CouncilSettingsScope;
  settings: CouncilSettings;
  revision: number;
  source: 'canonical_defaults' | 'stored';
  updated_at: string | null;
  updated_by: string | null;
}

interface StoredSettingsRecord {
  record_version: 'council-settings-record/v1';
  scope: CouncilSettingsScope;
  revision: number;
  settings: CouncilSettings;
  updated_at: string;
  updated_by: string;
}

export class CouncilSettingsService {
  private readonly directory: string;

  constructor(directory?: string) {
    this.directory = directory ?? join(dirname(getDbPath()), 'council-settings');
  }

  private fileFor(scope: CouncilSettingsScope): string {
    const key = createHash('sha256').update(canonicalStringify(scope)).digest('hex');
    return join(this.directory, `${key}.json`);
  }

  private readRecord(scope: CouncilSettingsScope): StoredSettingsRecord | null {
    const file = this.fileFor(scope);
    if (!existsSync(file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new CouncilApiError(
        'PERSISTENCE_INTERNAL',
        `The stored council settings for this scope are unreadable (corrupt record at ${file}). Defaults were NOT silently substituted.`,
        { status: 500, action: 'contact_support' },
      );
    }
    const record = parsed as StoredSettingsRecord;
    if (
      !record ||
      record.record_version !== 'council-settings-record/v1' ||
      record.scope?.tenant_id !== scope.tenant_id ||
      record.scope?.company_id !== scope.company_id ||
      record.scope?.installation_id !== scope.installation_id
    ) {
      throw new CouncilApiError(
        'PERSISTENCE_INTERNAL',
        'The stored council settings record does not belong to this scope or has an unknown record version. Defaults were NOT silently substituted.',
        { status: 500, action: 'contact_support' },
      );
    }
    const check = validateCouncilSettings(record.settings);
    if (!check.ok) {
      throw new CouncilApiError(
        'PERSISTENCE_INTERNAL',
        `The stored council settings fail canonical validation: ${JSON.stringify(check.issues)}. Defaults were NOT silently substituted.`,
        { status: 500, action: 'contact_support' },
      );
    }
    return record;
  }

  /** The settings in force for one scope. */
  getSettings(scope: CouncilSettingsScope): CouncilSettingsView {
    const record = this.readRecord(scope);
    if (!record) {
      return {
        scope,
        settings: DEFAULT_COUNCIL_SETTINGS,
        revision: 0,
        source: 'canonical_defaults',
        updated_at: null,
        updated_by: null,
      };
    }
    return {
      scope,
      settings: record.settings,
      revision: record.revision,
      source: 'stored',
      updated_at: record.updated_at,
      updated_by: record.updated_by,
    };
  }

  /**
   * Replace the scope's settings under a revision compare-and-swap.
   * The submission must be a complete canonical CouncilSettings
   * record (the schema is a strict object; unknown keys fail).
   */
  patchSettings(
    scope: CouncilSettingsScope,
    input: { settings: unknown; expected_revision: number; actor_subject: string },
  ): CouncilSettingsView {
    const check = validateCouncilSettings(input.settings);
    if (!check.ok) {
      throw new CouncilApiError(
        'SCHEMA_VALIDATION',
        `The submitted council settings fail canonical validation: ${JSON.stringify(check.issues)}`,
        { status: 400, action: 'fix_request' },
      );
    }
    const current = this.readRecord(scope);
    const currentRevision = current?.revision ?? 0;
    if (input.expected_revision !== currentRevision) {
      throw new CouncilApiError(
        'VERSION_MISMATCH',
        `Council settings for this scope are at revision ${currentRevision}, not ${input.expected_revision}. Nothing was written; reload and retry.`,
        { status: 409, action: 'reload_and_retry' },
      );
    }
    const record: StoredSettingsRecord = {
      record_version: 'council-settings-record/v1',
      scope,
      revision: currentRevision + 1,
      settings: input.settings as CouncilSettings,
      updated_at: new Date().toISOString(),
      updated_by: input.actor_subject,
    };
    mkdirSync(this.directory, { recursive: true });
    const file = this.fileFor(scope);
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return {
      scope,
      settings: record.settings,
      revision: record.revision,
      source: 'stored',
      updated_at: record.updated_at,
      updated_by: record.updated_by,
    };
  }
}
