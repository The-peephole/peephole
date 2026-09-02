import { readFile } from "node:fs/promises"

import type { PostgresDatabase } from "./database"

const INITIAL_MIGRATION = new URL(
  "./migrations/001_initial.sql",
  import.meta.url,
)

export async function applyPostgresMigrations(
  database: PostgresDatabase,
): Promise<void> {
  const sql = await readFile(INITIAL_MIGRATION, "utf8")
  await database.transaction(async (client) => {
    await client.query(sql)
  })
}
