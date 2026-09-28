import type { QueryResultRow } from "pg"

import {
  validateTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../../types/temporaryDatabase"
import type { PostgresDatabase } from "../preview-api/postgres/database"
import {
  TemporaryDatabaseOwnershipError,
  type CreateTemporaryDatabaseOwnership,
  type TemporaryDatabaseOwnershipStore,
} from "./ports"

interface TemporaryDatabaseRow extends QueryResultRow {
  resource_id: string
  preview_id: string
  backend_runtime_id: string
  status: TemporaryDatabaseStatus
  created_at: Date | string
  updated_at: Date | string
}

const SELECT_OWNERSHIP = `
  SELECT resource_id, preview_id, backend_runtime_id, status,
         created_at, updated_at
  FROM peephole_temporary_databases
`

export class PostgresTemporaryDatabaseOwnershipStore implements TemporaryDatabaseOwnershipStore {
  constructor(private readonly database: PostgresDatabase) {}

  async createProvisioning(
    input: CreateTemporaryDatabaseOwnership,
  ): Promise<TemporaryDatabaseRecord> {
    try {
      const result = await this.database.query<TemporaryDatabaseRow>(
        `
          INSERT INTO peephole_temporary_databases (
            resource_id, preview_id, backend_runtime_id, status,
            created_at, updated_at
          ) VALUES ($1, $2, $3, 'provisioning', $4, $4)
          RETURNING resource_id, preview_id, backend_runtime_id, status,
                    created_at, updated_at
        `,
        [input.resourceId, input.previewId, input.backendRuntimeId, input.now],
      )
      const row = result.rows[0]
      if (!row || result.rowCount !== 1) {
        throw new TemporaryDatabaseOwnershipError("PERSISTENCE_FAILED")
      }
      return toRecord(row)
    } catch (error) {
      if (error instanceof TemporaryDatabaseOwnershipError) throw error
      if (postgresErrorCode(error) === "23503") {
        throw new TemporaryDatabaseOwnershipError("OWNER_NOT_FOUND")
      }
      if (postgresErrorCode(error) === "23505") {
        throw new TemporaryDatabaseOwnershipError("CONFLICT")
      }
      throw new TemporaryDatabaseOwnershipError("PERSISTENCE_FAILED")
    }
  }

  async getByResourceId(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null> {
    const result = await this.database.query<TemporaryDatabaseRow>(
      `${SELECT_OWNERSHIP} WHERE resource_id = $1`,
      [resourceId],
    )
    return result.rows[0] ? toRecord(result.rows[0]) : null
  }

  async getByPreviewId(
    previewId: string,
  ): Promise<TemporaryDatabaseRecord | null> {
    const result = await this.database.query<TemporaryDatabaseRow>(
      `${SELECT_OWNERSHIP} WHERE preview_id = $1`,
      [previewId],
    )
    return result.rows[0] ? toRecord(result.rows[0]) : null
  }

  async listAll(): Promise<TemporaryDatabaseRecord[]> {
    const result = await this.database.query<TemporaryDatabaseRow>(
      `${SELECT_OWNERSHIP} ORDER BY created_at ASC, resource_id ASC`,
    )
    return result.rows.map(toRecord)
  }

  markProvisioned(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    return this.transition(resourceId, "provisioning", "provisioned", now)
  }

  markRevoking(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    return this.transition(resourceId, "provisioned", "revoking", now)
  }

  markRevoked(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    return this.transition(resourceId, "revoking", "revoked", now)
  }

  markRevokeFailed(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    return this.transition(resourceId, "revoking", "revoke_failed", now)
  }

  private async transition(
    resourceId: TemporaryDatabaseResourceId,
    from: TemporaryDatabaseStatus,
    to: TemporaryDatabaseStatus,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    try {
      const result = await this.database.query<TemporaryDatabaseRow>(
        `
          UPDATE peephole_temporary_databases
          SET status = $3, updated_at = $4
          WHERE resource_id = $1 AND status = $2
          RETURNING resource_id, preview_id, backend_runtime_id, status,
                    created_at, updated_at
        `,
        [resourceId, from, to, now],
      )
      const row = result.rows[0]
      if (!row || result.rowCount !== 1) {
        throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
      }
      return toRecord(row)
    } catch (error) {
      if (error instanceof TemporaryDatabaseOwnershipError) throw error
      throw new TemporaryDatabaseOwnershipError("PERSISTENCE_FAILED")
    }
  }
}

function toRecord(row: TemporaryDatabaseRow): TemporaryDatabaseRecord {
  return {
    resourceId: validateTemporaryDatabaseResourceId(row.resource_id),
    previewId: row.preview_id,
    backendRuntimeId: row.backend_runtime_id,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null
  return typeof error.code === "string" ? error.code : null
}
