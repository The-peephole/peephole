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
  beginReconciliation(
    resourceId: TemporaryDatabaseResourceId,
    expectedStatus: TemporaryDatabaseReconciliationSourceStatus,
    now: Date,
  ): Promise<TemporaryDatabaseRecord>
}

export type TemporaryDatabaseReconciliationSourceStatus =
  "provisioning" | "provisioned" | "revoke_failed"

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

export interface TenantPhysicalDatabase {
  readonly name: string
  readonly resourceId: TemporaryDatabaseResourceId | null
  readonly ownerName: string
  readonly allowsConnections: boolean
}

export interface TenantRoleMembership {
  readonly admin: boolean
  readonly set: boolean
  readonly inherit: boolean
  readonly unexpected: boolean
}

export interface TenantPhysicalRole {
  readonly name: string
  readonly resourceId: TemporaryDatabaseResourceId | null
  readonly canLogin: boolean
  readonly superuser: boolean
  readonly createDatabase: boolean
  readonly createRole: boolean
  readonly replication: boolean
  readonly bypassRls: boolean
  readonly connectionLimit: number
  readonly membership: TenantRoleMembership
}

export interface TenantPhysicalSnapshot {
  readonly provisioningRole: string
  readonly databases: readonly TenantPhysicalDatabase[]
  readonly roles: readonly TenantPhysicalRole[]
}

export interface TenantResourcePresence {
  readonly database: boolean
  readonly role: boolean
}

export interface TemporaryDatabaseTenantCatalog {
  snapshot(): Promise<TenantPhysicalSnapshot>
  inspectResource(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TenantResourcePresence>
}

export interface TemporaryDatabasePhysicalCleaner {
  cleanupFull(resourceId: TemporaryDatabaseResourceId): Promise<void>
  cleanupRoleOnly(resourceId: TemporaryDatabaseResourceId): Promise<void>
}
