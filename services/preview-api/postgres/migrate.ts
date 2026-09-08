import { readFile } from "node:fs/promises"

import type { PostgresDatabase } from "./database"

// Applied in order, every time the process starts -- there is no
// migration-tracking table, so each file's DDL must stay idempotent
// (CREATE TABLE/INDEX IF NOT EXISTS, no destructive ALTER/DROP) so it is
// always safe to re-run against a database that already has it applied.
const MIGRATIONS = [
  new URL("./migrations/001_initial.sql", import.meta.url),
  new URL("./migrations/002_production_artifacts.sql", import.meta.url),
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
