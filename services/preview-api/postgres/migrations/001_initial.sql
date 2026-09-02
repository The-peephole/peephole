CREATE TABLE IF NOT EXISTS peephole_preview_jobs (
  id text PRIMARY KEY,
  requester_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  repository jsonb NOT NULL,
  plan jsonb NOT NULL,
  cache_key text NOT NULL,
  cache_status text NOT NULL CHECK (cache_status IN ('hit', 'miss')),
  status text NOT NULL CHECK (
    status IN (
      'queued', 'fetching', 'installing', 'building', 'publishing',
      'ready', 'failed', 'cancelled', 'expired'
    )
  ),
  artifact jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (requester_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS peephole_preview_jobs_status_idx
  ON peephole_preview_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS peephole_preview_jobs_expiry_idx
  ON peephole_preview_jobs (expires_at);

CREATE TABLE IF NOT EXISTS peephole_preview_queue (
  job_id text PRIMARY KEY REFERENCES peephole_preview_jobs(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'cancelled')),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS peephole_preview_queue_available_idx
  ON peephole_preview_queue (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS peephole_preview_artifacts (
  cache_key text PRIMARY KEY,
  artifact_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS peephole_preview_artifacts_expiry_idx
  ON peephole_preview_artifacts (expires_at);

CREATE TABLE IF NOT EXISTS peephole_preview_quota (
  scope_key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (scope_key, window_start)
);

CREATE INDEX IF NOT EXISTS peephole_preview_quota_window_idx
  ON peephole_preview_quota (window_start);
