-- M9 Phase 2A: durable orchestration foundation for FullStackPreview.
-- frontend_job_id/artifact_id/backend_runtime_id are nullable: this row
-- must exist BEFORE either child resource does (see D-031). ON DELETE
-- SET NULL, never CASCADE/RESTRICT, on both FKs a shared resource points
-- at -- a full-stack preview's own lifecycle must never block the normal
-- reaper for a static artifact (peephole_production_artifacts) or preview
-- job (peephole_preview_jobs) that some *other*, unrelated request may
-- also still be using. backend_runtime_id intentionally has NO FK:
-- backend-v1 runtime state remains in-memory only in M9 (D-030), so there
-- is no durable table to reference. No CHECK ties status='ready' to these
-- columns being non-null -- that invariant is enforced only in
-- FullStackPreviewControlPlane.activateReady(), never at the schema level,
-- so it can never conflict with the ON DELETE SET NULL cleanup above.
CREATE TABLE IF NOT EXISTS peephole_fullstack_previews (
  id text PRIMARY KEY,
  requester_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  repository jsonb NOT NULL,
  frontend_source_root text NOT NULL,
  backend_source_root text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'queued', 'building_frontend', 'starting_backend', 'ready',
      'stopping', 'stopped', 'failed', 'cancelled', 'expired'
    )
  ),
  url text,
  frontend_job_id text REFERENCES peephole_preview_jobs(id) ON DELETE SET NULL,
  artifact_id text REFERENCES peephole_production_artifacts(artifact_id) ON DELETE SET NULL,
  backend_runtime_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (requester_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS peephole_fullstack_previews_status_idx
  ON peephole_fullstack_previews (status, created_at);
CREATE INDEX IF NOT EXISTS peephole_fullstack_previews_expiry_idx
  ON peephole_fullstack_previews (expires_at);

-- Modeled directly on peephole_preview_queue -- same statuses, same
-- lease/attempt shape -- rather than inventing a second queue system.
CREATE TABLE IF NOT EXISTS peephole_fullstack_queue (
  preview_id text PRIMARY KEY
    REFERENCES peephole_fullstack_previews(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'cancelled')),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS peephole_fullstack_queue_available_idx
  ON peephole_fullstack_queue (status, available_at, created_at);
