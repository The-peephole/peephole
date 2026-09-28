import type { QueryResultRow } from "pg"

import type { TemporaryDatabaseResourceId } from "../../core/backendDatabase/resourceIdentity"
import type { TemporaryDatabaseRecord } from "../../types/temporaryDatabase"
import type { SqlResult } from "../preview-api/postgres/database"

export type TemporaryDatabaseOwnershipErrorCode =
  "CONFLICT" | "OWNER_NOT_FOUND" | "TRANSITION_REJECTED" | "PERSISTENCE_FAILED"

export class TemporaryDatabaseOwnershipError extends Error {
  constructor(readonly code: TemporaryDatabaseOwnershipErrorCode) {
    super("Temporary database ownership persistence failed.")
    this.name = "TemporaryDatabaseOwnershipError"
  }
}

export interface CreateTemporaryDatabaseOwnership {
  readonly resourceId: TemporaryDatabaseResourceId
  readonly previewId: string
  readonly backendRuntimeId: string
  readonly now: Date
}

export interface TemporaryDatabaseOwnershipStore {
  createProvisioning(
    input: CreateTemporaryDatabaseOwnership,
  ): Promise<TemporaryDatabaseRecord>
  getByResourceId(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null>
  getByPreviewId(previewId: string): Promise<TemporaryDatabaseRecord | null>
  listAll(): Promise<TemporaryDatabaseRecord[]>
  markProvisioned(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord>
  markRevoking(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord>
  markRevoked(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord>
  markRevokeFailed(
    resourceId: TemporaryDatabaseResourceId,
    now: Date,
  ): Promise<TemporaryDatabaseRecord>
}

export interface TenantAdminSession {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>
  /** Prevents a session with unproven role state from returning to the pool. */
  discard(): void
}

export interface TenantDatabaseAdmin {
  withSession<T>(
    operation: (session: TenantAdminSession) => Promise<T>,
  ): Promise<T>
}
