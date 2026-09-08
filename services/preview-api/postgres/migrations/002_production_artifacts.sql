-- Persistent authorization/expiry metadata for ProductionArtifactHost
-- (services/production/artifactHost.ts). Deliberately separate from
-- peephole_preview_artifacts: that table is a build-*cache* keyed by
-- cache_key (one row per distinct build plan, reused across many jobs),
-- while this one is keyed by artifact_id and is the authoritative source
-- for whether/how-long the production artifact listener may actually serve
-- a given artifact's files -- a different lifetime and a different lookup
-- key, so it does not belong in the same row.
CREATE TABLE IF NOT EXISTS peephole_production_artifacts (
  artifact_id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS peephole_production_artifacts_expiry_idx
  ON peephole_production_artifacts (expires_at);
