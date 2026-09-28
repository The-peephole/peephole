-- M11-C2A: durable ownership evidence for one temporary database per
-- FullStack preview. This table intentionally contains identifiers and
-- lifecycle state only; credential material and derived PostgreSQL object
-- names are never durable.
CREATE TABLE IF NOT EXISTS peephole_temporary_databases (
  resource_id text PRIMARY KEY
    CONSTRAINT peephole_temporary_databases_resource_id_check
    CHECK (resource_id ~ '^r[a-f0-9]{28}$'),
  preview_id text NOT NULL
    REFERENCES peephole_fullstack_previews(id) ON DELETE RESTRICT,
  backend_runtime_id text NOT NULL,
  status text NOT NULL
    CONSTRAINT peephole_temporary_databases_status_check
    CHECK (
      status IN (
        'provisioning', 'provisioned', 'revoking', 'revoked',
        'revoke_failed'
      )
    ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT peephole_temporary_databases_preview_id_key UNIQUE (preview_id),
  CONSTRAINT peephole_temporary_databases_backend_runtime_id_key
    UNIQUE (backend_runtime_id)
);

CREATE INDEX IF NOT EXISTS peephole_temporary_databases_status_updated_idx
  ON peephole_temporary_databases (status, updated_at);
