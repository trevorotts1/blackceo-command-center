/**
 * Canonical council_* schema (CWE-005, directive Section 16).
 *
 * GENERATED COPY: COUNCIL_SCHEMA_SQL below is identical, after comment
 * stripping and whitespace normalization, to the canonical definition
 * owned by CWE-005 in the onboarding runtime at
 * 77-council-of-wise-elders/runtime/src/persistence/migrations/
 * 0001-council-schema.sql. Do not edit one copy without the other; the
 * CWE-005 build report records the parity check.
 *
 * Everything is additive (IF NOT EXISTS throughout): the migration is a
 * no-op when re-applied, the DATA-01 additive self-heal path may apply
 * it, and rollback never needs a destructive downgrade. The SQL is kept
 * as one script because trigger bodies contain semicolons; hosts apply
 * it with a single exec call inside one transaction.
 */

export const COUNCIL_SCHEMA_MIGRATION_NAME = 'council_scoped_storage_schema';

/** The 18 tables of directive Section 16.2, in creation order. */
export const COUNCIL_TABLES_SECTION_16_2 = [
  'council_sessions',
  'council_brief_revisions',
  'council_evidence',
  'council_cards',
  'council_challenges',
  'council_verdicts',
  'council_events',
  'council_jobs',
  'council_provider_attempts',
  'council_budget_reservations',
  'council_action_proposals',
  'council_approvals',
  'council_run_previews',
  'council_diagnostic_capture',
  'council_task_links',
  'council_outcome_reviews',
  'council_request_keys',
  'council_projection_outbox',
] as const;

/**
 * One extra table from the CWE-005 prose block's owned-paths list
 * (council_kanban_links). Additive; wired by CWE-021/CWE-042. Not part of
 * the Section 16.2 inventory.
 */
export const COUNCIL_TABLES_PROSE_BLOCK_EXTRA = ['council_kanban_links'] as const;

/** The canonical schema script. Apply with one exec inside one transaction. */
export const COUNCIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS council_sessions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  owner_subject TEXT,
  created_by_subject TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'selected', 'quick', 'consult')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'company')),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'READY', 'QUEUED', 'PREPARING', 'ROUND_1', 'CRUX_REVIEW',
    'ROUND_2', 'DRAFT_RESOLUTION', 'ROUND_3', 'CONSULTING', 'VERIFYING',
    'COMPLETED', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED',
    'CANCELLED', 'BLOCKED', 'RESUMING', 'FAILED')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  brief_revision INTEGER NOT NULL DEFAULT 0 CHECK (brief_revision >= 0),
  brief_hash TEXT NOT NULL DEFAULT '',
  selected_seats_json TEXT NOT NULL DEFAULT '[]',
  economic_context_json TEXT,
  entitlement_snapshot_json TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  active_attempt_id TEXT,
  cancellation_generation INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, id),
  CHECK (visibility = 'company' OR owner_subject IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS council_brief_revisions (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  brief_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  evidence_manifest_hash TEXT NOT NULL DEFAULT '',
  preference_private INTEGER NOT NULL DEFAULT 0 CHECK (preference_private IN (0, 1)),
  weights_json TEXT,
  route_snapshot_json TEXT,
  question TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  stakes TEXT NOT NULL,
  deadline TEXT,
  reversibility TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  author_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, revision),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_evidence (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'owner_statement', 'company_data', 'customer_data', 'external_reference',
    'generated_summary')),
  attachment_ref TEXT,
  summary_json TEXT,
  content_hash TEXT NOT NULL,
  attribution TEXT NOT NULL CHECK (attribution IN ('source_principle', 'blackceo_adaptation')),
  claim TEXT NOT NULL,
  strength TEXT NOT NULL CHECK (strength IN ('low', 'medium', 'high')),
  verification TEXT NOT NULL CHECK (verification IN ('pending', 'valid', 'invalid')),
  created_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  CHECK (attachment_ref IS NOT NULL OR summary_json IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_cards (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('advisor', 'ratification', 'consult')),
  seat_id TEXT CHECK (seat_id IS NULL OR seat_id IN (
    'simon-sinek', 'td-jakes', 'oprah-winfrey', 'tiffany-aliche',
    'russell-brunson', 'michelle-obama', 'brene-brown', 'dennis-kimbro',
    'les-brown')),
  round INTEGER NOT NULL CHECK (round >= 0),
  brief_revision INTEGER NOT NULL CHECK (brief_revision >= 1),
  operation_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  card_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  model_receipt_json TEXT,
  prev_hash TEXT NOT NULL DEFAULT '',
  validation TEXT NOT NULL CHECK (validation IN ('pending', 'valid', 'invalid')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id, operation_id),
  CHECK (kind <> 'advisor' OR seat_id IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_challenges (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('crux', 'follow_up', 'resolution_challenge')),
  challenger_seat_id TEXT CHECK (challenger_seat_id IS NULL OR challenger_seat_id IN (
    'simon-sinek', 'td-jakes', 'oprah-winfrey', 'tiffany-aliche',
    'russell-brunson', 'michelle-obama', 'brene-brown', 'dennis-kimbro',
    'les-brown')),
  target_ref TEXT NOT NULL,
  challenge_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'satisfied', 'waived_by_owner', 'unresolved')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_verdicts (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  brief_revision INTEGER NOT NULL CHECK (brief_revision >= 1),
  verdict_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  verdict_hash TEXT NOT NULL,
  cards_root_hash TEXT NOT NULL,
  brief_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  validation_run_hash TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN (
    'GO', 'GO_WITH_CONDITIONS', 'RESHAPE', 'DONT_DO_IT', 'WAIT',
    'INSUFFICIENT_EVIDENCE')),
  validation TEXT NOT NULL CHECK (validation IN ('pending', 'valid', 'invalid')),
  ratification TEXT NOT NULL CHECK (ratification IN (
    'not_required', 'pending', 'ratified', 'not_run_by_quick_mode_policy',
    'material_change_unratified', 'rejected')),
  chosen_option_id TEXT,
  client_decision_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id, brief_revision),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_events (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'session_created', 'session_state_changed', 'brief_revised',
    'card_accepted', 'crux_identified', 'resolution_drafted',
    'verdict_validated', 'grant_issued', 'grant_revoked',
    'operation_reserved', 'operation_completed', 'session_paused',
    'session_cancelled', 'session_blocked', 'session_failed')),
  from_state TEXT,
  to_state TEXT,
  actor_subject TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL DEFAULT '',
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, sequence),
  UNIQUE (tenant_id, company_id, session_id, id),
  CHECK (from_state IS NULL OR from_state IN (
    'DRAFT', 'READY', 'QUEUED', 'PREPARING', 'ROUND_1', 'CRUX_REVIEW',
    'ROUND_2', 'DRAFT_RESOLUTION', 'ROUND_3', 'CONSULTING', 'VERIFYING',
    'COMPLETED', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED',
    'CANCELLED', 'BLOCKED', 'RESUMING', 'FAILED')),
  CHECK (to_state IS NULL OR to_state IN (
    'DRAFT', 'READY', 'QUEUED', 'PREPARING', 'ROUND_1', 'CRUX_REVIEW',
    'ROUND_2', 'DRAFT_RESOLUTION', 'ROUND_3', 'CONSULTING', 'VERIFYING',
    'COMPLETED', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED',
    'CANCELLED', 'BLOCKED', 'RESUMING', 'FAILED')),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_jobs (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter',
    'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_json TEXT,
  terminal_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, kind, idempotency_key),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_provider_attempts (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  job_id TEXT,
  operation_id TEXT NOT NULL,
  seat_id TEXT CHECK (seat_id IS NULL OR seat_id IN (
    'simon-sinek', 'td-jakes', 'oprah-winfrey', 'tiffany-aliche',
    'russell-brunson', 'michelle-obama', 'brene-brown', 'dennis-kimbro',
    'les-brown')),
  round INTEGER NOT NULL CHECK (round >= 0),
  provider_id TEXT NOT NULL,
  provider_config_version TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  model_selection_source TEXT NOT NULL CHECK (model_selection_source IN (
    'explicit', 'client_default', 'route_default')),
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'dispatched', 'accepted', 'provider_completion_unknown',
    'failed', 'cancelled')),
  outcome_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  actual_cost_minor INTEGER CHECK (actual_cost_minor IS NULL OR actual_cost_minor >= 0),
  currency TEXT,
  request_hash TEXT NOT NULL DEFAULT '',
  response_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, operation_id),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_budget_reservations (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  estimate_minor INTEGER NOT NULL CHECK (estimate_minor >= 0),
  actual_minor INTEGER CHECK (actual_minor IS NULL OR actual_minor >= 0),
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'expired', 'unknown')),
  hold_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, operation_id),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_action_proposals (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  verdict_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  risk_class TEXT NOT NULL CHECK (risk_class IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'approved', 'rejected', 'superseded', 'executed', 'expired')),
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id, plan_hash),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_approvals (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run_grant', 'action_plan')),
  session_id TEXT,
  action_proposal_id TEXT,
  authority_mode TEXT CHECK (authority_mode IS NULL OR authority_mode IN (
    'managed_principal', 'local_interactive_owner', 'existing_standing_grant')),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN (
    'council_run', 'capability_probe', 'intake_refinement', 'follow_up')),
  actor_subject TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  parent_approval_id TEXT,
  scope_proof TEXT NOT NULL,
  current_plan_hash TEXT,
  verdict_hash TEXT,
  max_cost_minor INTEGER CHECK (max_cost_minor IS NULL OR max_cost_minor >= 0),
  currency TEXT,
  seat_allowlist_json TEXT,
  company_scope_verified INTEGER NOT NULL DEFAULT 0 CHECK (company_scope_verified IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'exhausted')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  consumed_at TEXT,
  PRIMARY KEY (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, kind, id),
  CHECK ((kind = 'run_grant' AND authority_mode IS NOT NULL AND purpose IS NOT NULL)
      OR (kind = 'action_plan' AND action_proposal_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id, session_id, action_proposal_id)
    REFERENCES council_action_proposals (tenant_id, company_id, session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id, parent_approval_id)
    REFERENCES council_approvals (tenant_id, company_id, id)
);

CREATE TABLE IF NOT EXISTS council_run_previews (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  estimate_minor INTEGER NOT NULL CHECK (estimate_minor >= 0),
  currency TEXT NOT NULL,
  cost_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (cost_confirmed IN (0, 1)),
  frozen_seat_count INTEGER NOT NULL CHECK (frozen_seat_count >= 0),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('low', 'medium', 'high', 'critical')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id, preview_hash),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id, grant_id)
    REFERENCES council_approvals (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_diagnostic_capture (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('grant', 'payload', 'metadata')),
  grant_id TEXT,
  policy_schema_version TEXT,
  authorized_by_principal TEXT,
  authorization_kind TEXT CHECK (authorization_kind IS NULL OR authorization_kind IN (
    'owner', 'audited_support')),
  window_started_at TEXT,
  window_ends_at TEXT,
  capture_window_minutes INTEGER CHECK (capture_window_minutes IS NULL
    OR (capture_window_minutes >= 1 AND capture_window_minutes <= 240)),
  payload_ttl_hours INTEGER CHECK (payload_ttl_hours IS NULL
    OR (payload_ttl_hours >= 1 AND payload_ttl_hours <= 72)),
  max_bytes_per_operation INTEGER CHECK (max_bytes_per_operation IS NULL
    OR (max_bytes_per_operation >= 1 AND max_bytes_per_operation <= 5242880)),
  max_bytes_per_session INTEGER CHECK (max_bytes_per_session IS NULL
    OR (max_bytes_per_session >= 1 AND max_bytes_per_session <= 26214400)),
  operation_id TEXT,
  data_class TEXT,
  byte_count INTEGER CHECK (byte_count IS NULL OR byte_count >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  redaction_status TEXT CHECK (redaction_status IS NULL OR redaction_status IN (
    'redacted', 'unavailable')),
  payload_protected_ref TEXT,
  payload_deadline_at TEXT,
  response_hash TEXT,
  error_code TEXT,
  captured_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  CHECK ((record_kind = 'grant' AND grant_id IS NULL
      AND authorized_by_principal IS NOT NULL AND authorization_kind IS NOT NULL
      AND window_started_at IS NOT NULL AND window_ends_at IS NOT NULL
      AND capture_window_minutes IS NOT NULL AND payload_ttl_hours IS NOT NULL
      AND max_bytes_per_operation IS NOT NULL AND max_bytes_per_session IS NOT NULL
      AND payload_protected_ref IS NULL)
    OR (record_kind = 'payload' AND grant_id IS NOT NULL
      AND operation_id IS NOT NULL AND data_class IS NOT NULL
      AND byte_count IS NOT NULL AND redaction_status = 'redacted'
      AND payload_protected_ref IS NOT NULL AND payload_deadline_at IS NOT NULL
      AND captured_at IS NOT NULL)
    OR (record_kind = 'metadata' AND grant_id IS NOT NULL
      AND payload_protected_ref IS NULL)),
  CHECK (window_started_at IS NULL OR window_ends_at IS NULL
    OR (julianday(window_ends_at) - julianday(window_started_at)) * 1440.0
       <= capture_window_minutes + 0.001),
  CHECK (data_class IS NULL OR data_class NOT IN (
    'hidden_reasoning', 'access_token', 'cookie', 'authentication_header',
    'private_key')),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id, session_id, grant_id)
    REFERENCES council_diagnostic_capture (tenant_id, company_id, session_id, id)
);

CREATE TRIGGER IF NOT EXISTS trg_council_diag_payload_bounds
BEFORE INSERT ON council_diagnostic_capture
WHEN NEW.record_kind = 'payload'
BEGIN
  SELECT RAISE(ABORT, 'diagnostic payload exceeds its grant per-operation bound')
  WHERE NEW.byte_count > (
    SELECT g.max_bytes_per_operation FROM council_diagnostic_capture g
    WHERE g.tenant_id = NEW.tenant_id AND g.company_id = NEW.company_id
      AND g.session_id = NEW.session_id AND g.id = NEW.grant_id
      AND g.record_kind = 'grant');
  SELECT RAISE(ABORT, 'diagnostic payload exceeds its grant per-session bound')
  WHERE (
    SELECT COALESCE(SUM(byte_count), 0) FROM council_diagnostic_capture p
    WHERE p.tenant_id = NEW.tenant_id AND p.company_id = NEW.company_id
      AND p.session_id = NEW.session_id AND p.grant_id = NEW.grant_id
      AND p.record_kind = 'payload') + NEW.byte_count > (
    SELECT g.max_bytes_per_session FROM council_diagnostic_capture g
    WHERE g.tenant_id = NEW.tenant_id AND g.company_id = NEW.company_id
      AND g.session_id = NEW.session_id AND g.id = NEW.grant_id
      AND g.record_kind = 'grant');
END;

CREATE TRIGGER IF NOT EXISTS trg_council_diag_payload_window
BEFORE INSERT ON council_diagnostic_capture
WHEN NEW.record_kind = 'payload'
BEGIN
  SELECT RAISE(ABORT, 'diagnostic payload captured outside its grant window')
  WHERE NOT EXISTS (
    SELECT 1 FROM council_diagnostic_capture g
    WHERE g.tenant_id = NEW.tenant_id AND g.company_id = NEW.company_id
      AND g.session_id = NEW.session_id AND g.id = NEW.grant_id
      AND g.record_kind = 'grant' AND g.revoked_at IS NULL
      AND NEW.captured_at >= g.window_started_at
      AND NEW.captured_at <= g.window_ends_at);
  SELECT RAISE(ABORT, 'diagnostic payload deadline exceeds the 72 hour ceiling')
  WHERE NEW.payload_deadline_at IS NULL
     OR NEW.payload_deadline_at > datetime(NEW.captured_at, '+72 hours');
END;

CREATE TABLE IF NOT EXISTS council_task_links (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_session_task_id TEXT,
  action_proposal_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_board_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, action_proposal_id, action_id, plan_hash),
  UNIQUE (tenant_id, company_id, operation_id),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, company_id, session_id, action_proposal_id)
    REFERENCES council_action_proposals (tenant_id, company_id, session_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_outcome_reviews (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('7d', '30d', '90d', 'custom')),
  planned_measure_json TEXT,
  actual_evidence_json TEXT,
  review_json TEXT NOT NULL,
  client_conclusion TEXT,
  verdict_label TEXT CHECK (verdict_label IS NULL OR verdict_label IN (
    'GO', 'GO_WITH_CONDITIONS', 'RESHAPE', 'DONT_DO_IT', 'WAIT',
    'INSUFFICIENT_EVIDENCE')),
  reviewed_by_subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id, horizon),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS council_request_keys (
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  session_id TEXT,
  response_operation_id TEXT,
  response_status INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source, operation, request_key)
);

CREATE TABLE IF NOT EXISTS council_projection_outbox (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT,
  id TEXT NOT NULL,
  event_sequence INTEGER,
  topic TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, topic, idempotency_key),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_council_sessions_scope_time
  ON council_sessions (tenant_id, company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_sessions_scope_state
  ON council_sessions (tenant_id, company_id, state);
CREATE INDEX IF NOT EXISTS idx_council_sessions_owner
  ON council_sessions (tenant_id, company_id, owner_subject) WHERE owner_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_council_evidence_session
  ON council_evidence (tenant_id, company_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_cards_session_seat
  ON council_cards (tenant_id, company_id, session_id, seat_id);
CREATE INDEX IF NOT EXISTS idx_council_jobs_due
  ON council_jobs (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_council_attempts_session
  ON council_provider_attempts (tenant_id, company_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_reservations_expiry
  ON council_budget_reservations (state, hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_council_approvals_session
  ON council_approvals (tenant_id, company_id, session_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_council_outbox_pending
  ON council_projection_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_council_diag_grant_session
  ON council_diagnostic_capture (tenant_id, company_id, session_id, record_kind);
CREATE INDEX IF NOT EXISTS idx_council_diag_deadline
  ON council_diagnostic_capture (payload_deadline_at) WHERE record_kind = 'payload';

CREATE TABLE IF NOT EXISTS council_kanban_links (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_task_id TEXT NOT NULL,
  board_ref TEXT NOT NULL,
  column_ref TEXT,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, company_id, session_id, id),
  UNIQUE (tenant_id, company_id, session_id),
  UNIQUE (tenant_id, company_id, operation_id),
  FOREIGN KEY (tenant_id, company_id, session_id)
    REFERENCES council_sessions (tenant_id, company_id, id) ON DELETE CASCADE
);
`;
