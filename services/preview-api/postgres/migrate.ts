import { readFile } from "node:fs/promises"

import type { PostgresDatabase } from "./database"

// Applied in order, every time the process starts -- there is no
// migration-tracking table, so each file's DDL must stay idempotent. Bootstrap
// files use CREATE TABLE/INDEX IF NOT EXISTS; later schema evolutions guard any
// ALTER/DROP by inspecting the exact existing constraint first, so re-running
// against an already-migrated database is a no-op.
const MIGRATIONS = [
  new URL("./migrations/001_initial.sql", import.meta.url),
  new URL("./migrations/002_production_artifacts.sql", import.meta.url),
  new URL("./migrations/003_fullstack_previews.sql", import.meta.url),
  new URL(
    "./migrations/004_fullstack_awaiting_activation.sql",
    import.meta.url,
  ),
]

export async function applyPostgresMigrations(
  database: PostgresDatabase,
): Promise<void> {
  for (const migration of MIGRATIONS) {
    const sql = await readFile(migration, "utf8")
    await database.transaction(async (client) => {
      await client.query(sql)
    })
  }
}
