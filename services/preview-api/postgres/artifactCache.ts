import type { QueryResultRow } from "pg"

import type { PreviewArtifactCache } from "../ports"
import type { PostgresDatabase } from "./database"

interface ArtifactRow extends QueryResultRow {
  artifact_id: string
  expires_at: Date | string
}

export class PostgresPreviewArtifactCache implements PreviewArtifactCache {
  constructor(private readonly database: PostgresDatabase) {}

  async get(
    cacheKey: string,
    now: Date,
  ): Promise<{ artifactId: string; expiresAt: Date } | null> {
    const result = await this.database.query<ArtifactRow>(
      `
        SELECT artifact_id, expires_at
        FROM peephole_preview_artifacts
        WHERE cache_key = $1 AND expires_at > $2
      `,
      [cacheKey, now],
    )
    const row = result.rows[0]

    return row
      ? { artifactId: row.artifact_id, expiresAt: new Date(row.expires_at) }
      : null
  }

  async put(
    cacheKey: string,
    artifactId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.database.query(
      `
        INSERT INTO peephole_preview_artifacts (
          cache_key, artifact_id, expires_at, updated_at
        ) VALUES ($1, $2, $3, now())
        ON CONFLICT (cache_key) DO UPDATE
        SET artifact_id = EXCLUDED.artifact_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
      `,
      [cacheKey, artifactId, expiresAt],
    )
  }
}
