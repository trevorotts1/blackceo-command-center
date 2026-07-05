-- rescue-ticketing/schema.sql
-- FIX-RESCUE-07: durable Rescue-Rangers ticket store (Postgres / Supabase).
--
-- Replaces the volatile n8n workflow static-data store (wiped on every re-import,
-- never garbage-collected, no ids/ownership/severity/SLA/audit/reporting). Apply
-- once; the n8n workflow then reads/writes these tables via a Postgres/Supabase
-- credential. See README.md for the wiring + the alternative n8n Data Table path.

-- ---------------------------------------------------------------------------
-- Monotonic human-facing ticket number (RR-000123). The app formats it; the DB
-- guarantees uniqueness + monotonicity even under concurrent inserts.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS rr_ticket_seq START 1;

DO $$ BEGIN
  CREATE TYPE rr_severity  AS ENUM ('critical', 'high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rr_status AS ENUM
    ('OPEN','ACK','IN_PROGRESS','RESOLVED','ESCALATED','NEEDS_HUMAN','CLOSED','REOPENED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- tickets: one row per incident, mutated through its lifecycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id        text PRIMARY KEY,                         -- 'RR-000123'
  seq              bigint NOT NULL DEFAULT nextval('rr_ticket_seq'),
  client           text NOT NULL,
  box              text,                                      -- box / container / tunnel host
  box_type         text,                                      -- 'mac-tunnel' | 'vps' | ''
  agent            text,                                      -- client agent id (e.g. 'main')
  person           text,                                      -- human contact
  failure_class    text NOT NULL,
  severity         rr_severity NOT NULL,
  status           rr_status NOT NULL DEFAULT 'OPEN',
  owner            text NOT NULL DEFAULT 'rescue-agent',      -- 'rescue-agent' | 'operator'
  source           text NOT NULL,                             -- 'pathA' (real-time push) | 'pathB' (poller/heartbeat)
  decision_mode    text,                                      -- deliver-answer | coach-client-agent | fix-it-ourselves | escalate-human
  problem          text,
  answer           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  resolved_at      timestamptz,
  resolved_by      text,
  sla_due_at       timestamptz NOT NULL,
  escalated_at     timestamptz,
  dedup_key        text NOT NULL,                             -- hash(client + failure_class)
  day_count_key    text NOT NULL,                             -- e.g. 'client-class-YYYY-MM-DD' for the 25/day cap
  recurred_count   int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tickets_status_idx    ON tickets (status);
CREATE INDEX IF NOT EXISTS tickets_dedup_idx     ON tickets (dedup_key, status);
CREATE INDEX IF NOT EXISTS tickets_sla_idx       ON tickets (sla_due_at) WHERE status NOT IN ('RESOLVED','CLOSED');
CREATE INDEX IF NOT EXISTS tickets_daycount_idx  ON tickets (day_count_key);
CREATE INDEX IF NOT EXISTS tickets_client_idx    ON tickets (client, failure_class, created_at);

-- ---------------------------------------------------------------------------
-- ticket_events: append-only audit trail. Every state change writes one row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_events (
  id           bigserial PRIMARY KEY,
  ticket_id    text NOT NULL REFERENCES tickets (ticket_id) ON DELETE CASCADE,
  from_status  rr_status,
  to_status    rr_status NOT NULL,
  actor        text NOT NULL,                                 -- 'rescue-agent' | 'operator' | 'sla-monitor'
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, at);

-- ===========================================================================
-- REPORTING VIEWS (the small read layer: open-by-severity, MTTR, repeat
-- offenders, cap usage). n8n / the operator query these directly.
-- ===========================================================================

-- Open tickets grouped by severity (triage board).
CREATE OR REPLACE VIEW rr_open_by_severity AS
SELECT severity, count(*) AS open_count
FROM tickets
WHERE status NOT IN ('RESOLVED','CLOSED')
GROUP BY severity
ORDER BY array_position(ARRAY['critical','high','medium','low']::text[], severity::text);

-- Mean time to resolution over the last 30 days, per severity.
CREATE OR REPLACE VIEW rr_mttr_30d AS
SELECT severity,
       count(*) AS resolved_count,
       round(avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0)::numeric, 1) AS mttr_minutes
FROM tickets
WHERE resolved_at IS NOT NULL AND resolved_at >= now() - interval '30 days'
GROUP BY severity;

-- Repeat offenders: clients with the most tickets of a class in the last 30 days.
CREATE OR REPLACE VIEW rr_repeat_offenders AS
SELECT client, failure_class, count(*) AS incidents,
       max(created_at) AS last_seen
FROM tickets
WHERE created_at >= now() - interval '30 days'
GROUP BY client, failure_class
HAVING count(*) >= 2
ORDER BY incidents DESC;

-- Daily cap usage: how many distinct tickets minted per day-count key today
-- (the 25/day cap denominator; deduped recurrences do NOT appear here).
CREATE OR REPLACE VIEW rr_cap_usage_today AS
SELECT split_part(day_count_key, '::', 1) AS client,
       count(*) AS minted_today
FROM tickets
WHERE created_at::date = now()::date
GROUP BY split_part(day_count_key, '::', 1)
ORDER BY minted_today DESC;

-- SLA-breached open tickets (what the 5-minute monitor auto-escalates).
CREATE OR REPLACE VIEW rr_sla_breaches AS
SELECT ticket_id, client, severity, status, owner, sla_due_at,
       round(EXTRACT(EPOCH FROM (now() - sla_due_at)) / 60.0) AS minutes_overdue
FROM tickets
WHERE status NOT IN ('RESOLVED','CLOSED')
  AND sla_due_at <= now()
ORDER BY minutes_overdue DESC;

-- ---------------------------------------------------------------------------
-- Interim GC (run from Relay Brain / a daily job): drop tickets closed-resolved
-- more than 90 days ago, and their audit rows cascade. Keeps the store lean.
-- ---------------------------------------------------------------------------
-- DELETE FROM tickets
--  WHERE status = 'CLOSED' AND resolved_at IS NOT NULL
--    AND resolved_at < now() - interval '90 days';
