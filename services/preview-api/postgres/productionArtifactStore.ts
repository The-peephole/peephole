import type { QueryResultRow } from "pg"

import type { PostgresDatabase } from "./database"

export interface ProductionArtifactMetadata {
  expiresAt: Date
}

export interface ProductionArtifactStore {
  /**
   * Records that `artifactId` should be servable until at least
   * `expiresAt`. The *same* artifact can be signed again later (a build
   * cache hit re-serving an older artifact to a new job) with a shorter
   * expiry than it already has -- this must never shrink the persisted
   * expiry, only ever grow it, so a still-valid preview never starts
   * 410ing early just because a later request happened to ask for less
   * time than an earlier one already granted.
   */
  upsertMaxExpiry(artifactId: string, expiresAt: Date): Promise<void>
  /** Raw lookup, expired or not -- callers compare `expiresAt` against
   * their own clock so they can tell "never signed" (404) apart from
   * "signed, but expired" (410) themselves. */
  get(artifactId: string): Promise<ProductionArtifactMetadata | null>
  /** Artifact ids whose persisted expiry has already passed -- a
   * *candidate* list for reaping, not an authorization to delete: by the
   * time a caller actually acts on one of these ids, a concurrent sign()
   * may already have extended it into the future again. Use
   * deleteIfStillExpired() to make that decision safely. */
  listExpired(now: Date): Promise<string[]>
  /**
   * Atomically deletes the row if and only if it is still expired as of
   * `now` *at the moment this statement runs* -- not whenever the caller
   * last called listExpired(). Returns whether it actually deleted
   * anything.
   *
   * This is the only safe way to decide whether an artifact's on-disk
   * directory may also be deleted: listExpired() takes a snapshot, and a
   * concurrent sign() (a build-cache hit re-serving the same artifact to
   * a new job) can commit a future expiry for that same artifact_id in
   * the window between that snapshot and a reaper actually getting
   * around to deleting it. A plain unconditional delete() would destroy
   * a row sign() had *just* extended, right out from under it.
   */
  deleteIfStillExpired(artifactId: string, now: Date): Promise<boolean>
}

interface ArtifactRow extends QueryResultRow {
  artifact_id: string
  expires_at: Date | string
}

export class PostgresProductionArtifactStore implements ProductionArtifactStore {
  constructor(private readonly database: PostgresDatabase) {}

  async upsertMaxExpiry(artifactId: string, expiresAt: Date): Promise<void> {
    await this.database.query(
      `
        INSERT INTO peephole_production_artifacts (
          artifact_id, expires_at, updated_at
        ) VALUES ($1, $2, now())
        ON CONFLICT (artifact_id) DO UPDATE
        SET expires_at = GREATEST(
              peephole_production_artifacts.expires_at, EXCLUDED.expires_at
            ),
            updated_at = now()
      `,
      [artifactId, expiresAt],
    )
  }

  async get(artifactId: string): Promise<ProductionArtifactMetadata | null> {
    const result = await this.database.query<ArtifactRow>(
      `
        SELECT artifact_id, expires_at
        FROM peephole_production_artifacts
        WHERE artifact_id = $1
      `,
      [artifactId],
    )
    const row = result.rows[0]

    return row ? { expiresAt: new Date(row.expires_at) } : null
  }

  async listExpired(now: Date): Promise<string[]> {
    const result = await this.database.query<Pick<ArtifactRow, "artifact_id">>(
      `
        SELECT artifact_id
        FROM peephole_production_artifacts
        WHERE expires_at <= $1
      `,
      [now],
    )

    return result.rows.map((row) => row.artifact_id)
  }

  async deleteIfStillExpired(artifactId: string, now: Date): Promise<boolean> {
    const result = await this.database.query(
      `
        DELETE FROM peephole_production_artifacts
        WHERE artifact_id = $1 AND expires_at <= $2
      `,
      [artifactId, now],
    )

    return result.rowCount > 0
  }
}
