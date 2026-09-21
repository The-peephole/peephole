-- M9 Phase 2B: a provisioned frontend artifact plus a running backend is
-- still not browser-ready until the later routing/origin activation phase.
-- PostgreSQL cannot add a value to an anonymous CHECK constraint in place,
-- so replace only that constraint while leaving the Phase 2A migration
-- immutable. The guarded block is idempotent because every migration is
-- intentionally re-run at startup.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
    INTO constraint_name
  FROM pg_constraint AS con
  JOIN pg_class AS rel ON rel.oid = con.conrelid
  JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = current_schema()
    AND rel.relname = 'peephole_fullstack_previews'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%status%'
    AND pg_get_constraintdef(con.oid) LIKE '%building_frontend%'
    AND pg_get_constraintdef(con.oid) NOT LIKE '%awaiting_activation%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE peephole_fullstack_previews DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS con
    JOIN pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = current_schema()
      AND rel.relname = 'peephole_fullstack_previews'
      AND con.conname = 'peephole_fullstack_previews_status_check_v2'
  ) THEN
    ALTER TABLE peephole_fullstack_previews
      ADD CONSTRAINT peephole_fullstack_previews_status_check_v2 CHECK (
        status IN (
          'queued', 'building_frontend', 'starting_backend',
          'awaiting_activation', 'ready', 'stopping', 'stopped', 'failed',
          'cancelled', 'expired'
        )
      );
  END IF;
END $$;
