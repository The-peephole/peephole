import type { QueryResultRow } from "pg"

import type { PostgresDatabase } from "../preview-api/postgres/database"
import type { FullStackRoutingRecord, FullStackRoutingStore } from "./ports"

interface RoutingRow extends QueryResultRow {
  id: string
  status: FullStackRoutingRecord["status"]
  artifact_id: string | null
  backend_runtime_id: string | null
  expires_at: Date | string
}

export class PostgresFullStackRoutingStore implements FullStackRoutingStore {
  constructor(private readonly database: Pick<PostgresDatabase, "query">) {}

  async get(id: string): Promise<FullStackRoutingRecord | null> {
    const result = await this.database.query<RoutingRow>(
      `
        SELECT id, status, artifact_id, backend_runtime_id, expires_at
        FROM peephole_fullstack_previews
        WHERE id = $1
      `,
      [id],
    )
    const row = result.rows[0]
    return row
      ? {
          id: row.id,
          status: row.status,
          artifactId: row.artifact_id,
          backendRuntimeId: row.backend_runtime_id,
          expiresAt:
            row.expires_at instanceof Date
              ? new Date(row.expires_at)
              : new Date(row.expires_at),
        }
      : null
  }
}
