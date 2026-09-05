/** Additive tables; imported by central migrations without runtime dependencies. */
export const INTERVIEW_REMOTE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS interview_enrollment_uses (nonce TEXT PRIMARY KEY, used_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenant_interviews (
  tenant_id TEXT PRIMARY KEY, interview_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0,
  gateway_session_id TEXT, session_reservation TEXT, session_reserved_at TEXT,
  remote_status TEXT NOT NULL DEFAULT 'local', build_id TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_interview_answers (
  operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, interview_id TEXT NOT NULL,
  question_id TEXT NOT NULL, question_text TEXT NOT NULL, answer_text TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(tenant_id,interview_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_tenant_interview_answers ON tenant_interview_answers(tenant_id,interview_id,revision);
CREATE TABLE IF NOT EXISTS interview_remote_operations (
  operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, interview_id TEXT NOT NULL,
  operation_type TEXT NOT NULL, origin_subject TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_eligible_at TEXT, last_error TEXT, receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_remote_pending ON interview_remote_operations(state,next_eligible_at);
CREATE TABLE IF NOT EXISTS interview_receiver_receipts (
  operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT, created_at TEXT NOT NULL
);`;
