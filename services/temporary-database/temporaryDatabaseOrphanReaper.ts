import {
  deriveTemporaryDatabaseObjectName,
  type TemporaryDatabaseResourceId,
} from "../../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../../types/temporaryDatabase"
import {
  TemporaryDatabaseOwnershipError,
  type TemporaryDatabaseOwnershipStore,
  type TemporaryDatabasePhysicalCleaner,
  type TemporaryDatabaseReconciliationSourceStatus,
  type TemporaryDatabaseTenantCatalog,
  type TenantPhysicalDatabase,
  type TenantPhysicalRole,
  type TenantPhysicalSnapshot,
} from "./ports"
import { TemporaryDatabasePhysicalCleanupError } from "./temporaryDatabasePhysicalCleaner"

const DEFAULT_MAX_AGE_MS = 30 * 60_000

export type TemporaryDatabaseReconciliationErrorCode =
  | "AUDIT_FAILED"
  | "INVARIANT_VIOLATION"
  | "TRANSITION_REJECTED"
  | "CLEANUP_FAILED"
  | "CATALOG_UNAVAILABLE"

export class TemporaryDatabaseReconciliationError extends Error {
  constructor(readonly code: TemporaryDatabaseReconciliationErrorCode) {
    super("Temporary database reconciliation failed.")
    this.name = "TemporaryDatabaseReconciliationError"
  }
}

export interface TemporaryDatabaseOrphanReaperOptions {
  readonly ownershipStore: TemporaryDatabaseOwnershipStore
  readonly tenantCatalog: TemporaryDatabaseTenantCatalog
  readonly physicalCleaner: TemporaryDatabasePhysicalCleaner
  readonly maxAgeMs?: number
  readonly now?: () => Date
}

interface AuditedResource {
  readonly record: TemporaryDatabaseRecord
  readonly database: TenantPhysicalDatabase | null
  readonly role: TenantPhysicalRole | null
  readonly updatedAtMs: number
}

export class TemporaryDatabaseOrphanReaper {
  private readonly maxAgeMs: number
  private readonly now: () => Date

  constructor(private readonly options: TemporaryDatabaseOrphanReaperOptions) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new Error("Temporary database reaper maxAgeMs is invalid.")
    }
    this.now = options.now ?? (() => new Date())
  }

  reapAll(): Promise<TemporaryDatabaseResourceId[]> {
    return this.reconcile(true)
  }

  reap(): Promise<TemporaryDatabaseResourceId[]> {
    return this.reconcile(false)
  }

  private async reconcile(
    allNonTerminal: boolean,
  ): Promise<TemporaryDatabaseResourceId[]> {
    const records = await this.options.ownershipStore.listAll()
    let snapshot: TenantPhysicalSnapshot
    try {
      snapshot = await this.options.tenantCatalog.snapshot()
    } catch {
      throw new TemporaryDatabaseReconciliationError("CATALOG_UNAVAILABLE")
    }

    const nowMs = this.readNow()
    // Audit every durable and pv_* physical object before the first CAS or DROP.
    const audited = auditThreeSets(records, snapshot, nowMs)
    const candidates = audited.filter(({ record, updatedAtMs }) =>
      allNonTerminal
        ? record.status !== "revoked"
        : isMaintenanceCandidate(record.status) &&
          nowMs - updatedAtMs > this.maxAgeMs,
    )

    const removed: TemporaryDatabaseResourceId[] = []
    for (const resource of candidates) {
      await this.claim(resource.record)
      try {
        if (resource.database) {
          await this.options.physicalCleaner.cleanupFull(
            resource.record.resourceId,
          )
        } else if (resource.role) {
          await this.options.physicalCleaner.cleanupRoleOnly(
            resource.record.resourceId,
          )
        }
      } catch (error) {
        const databaseRemoved =
          !resource.database ||
          (error instanceof TemporaryDatabasePhysicalCleanupError &&
            error.databaseRemoved)
        if (databaseRemoved) {
          await this.options.ownershipStore
            .markRevokeFailed(resource.record.resourceId, this.readNowDate())
            .catch(() => undefined)
        }
        throw new TemporaryDatabaseReconciliationError("CLEANUP_FAILED")
      }

      let presence
      try {
        presence = await this.options.tenantCatalog.inspectResource(
          resource.record.resourceId,
        )
      } catch {
        throw new TemporaryDatabaseReconciliationError("CATALOG_UNAVAILABLE")
      }
      if (presence.database || presence.role) {
        if (!presence.database && presence.role) {
          await this.options.ownershipStore
            .markRevokeFailed(resource.record.resourceId, this.readNowDate())
            .catch(() => undefined)
        }
        throw new TemporaryDatabaseReconciliationError("CLEANUP_FAILED")
      }

      await this.options.ownershipStore.markRevoked(
        resource.record.resourceId,
        this.readNowDate(),
      )
      removed.push(resource.record.resourceId)
    }
    return removed
  }

  private async claim(record: TemporaryDatabaseRecord): Promise<void> {
    try {
      if (record.status === "revoking") {
        const current = await this.options.ownershipStore.getByResourceId(
          record.resourceId,
        )
        if (current?.status !== "revoking") {
          throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
        }
        return
      }
      if (!isReconciliationSource(record.status)) {
        throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
      }
      const claimed = await this.options.ownershipStore.beginReconciliation(
        record.resourceId,
        record.status,
        this.readNowDate(),
      )
      if (claimed.status !== "revoking") {
        throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
      }
    } catch {
      throw new TemporaryDatabaseReconciliationError("TRANSITION_REJECTED")
    }
  }

  private readNow(): number {
    const value = this.now()
    const milliseconds = value.getTime()
    if (!Number.isFinite(milliseconds)) {
      throw new TemporaryDatabaseReconciliationError("INVARIANT_VIOLATION")
    }
    return milliseconds
  }

  private readNowDate(): Date {
    return new Date(this.readNow())
  }
}

function auditThreeSets(
  records: readonly TemporaryDatabaseRecord[],
  snapshot: TenantPhysicalSnapshot,
  nowMs: number,
): AuditedResource[] {
  const durable = new Map(records.map((record) => [record.resourceId, record]))
  const databases = new Map<
    TemporaryDatabaseResourceId,
    TenantPhysicalDatabase
  >()
  const roles = new Map<TemporaryDatabaseResourceId, TenantPhysicalRole>()

  for (const database of snapshot.databases) {
    if (!database.resourceId) auditFailure()
    if (!durable.has(database.resourceId)) auditFailure()
    if (databases.has(database.resourceId)) auditFailure()
    databases.set(database.resourceId, database)
  }
  for (const role of snapshot.roles) {
    if (!role.resourceId) auditFailure()
    if (!durable.has(role.resourceId)) auditFailure()
    if (roles.has(role.resourceId)) auditFailure()
    roles.set(role.resourceId, role)
  }

  return records.map((record) => {
    const updatedAt = new Date(record.updatedAt)
    const updatedAtMs = updatedAt.getTime()
    if (
      !Number.isFinite(updatedAtMs) ||
      updatedAt.toISOString() !== record.updatedAt ||
      updatedAtMs > nowMs
    ) {
      invariantFailure()
    }
    const database = databases.get(record.resourceId) ?? null
    const role = roles.get(record.resourceId) ?? null
    auditDurableResource(record, database, role)
    return { record, database, role, updatedAtMs }
  })
}

function auditDurableResource(
  record: TemporaryDatabaseRecord,
  database: TenantPhysicalDatabase | null,
  role: TenantPhysicalRole | null,
): void {
  const objectName = deriveTemporaryDatabaseObjectName(record.resourceId)
  if (record.status === "revoked") {
    if (database || role) invariantFailure()
    return
  }
  if (record.status === "revoke_failed" && database) invariantFailure()
  if (database && !role) invariantFailure()
  if (record.status === "provisioned" && (!database || !role)) {
    invariantFailure()
  }

  if (role) {
    if (
      role.name !== objectName ||
      !role.canLogin ||
      role.superuser ||
      role.createDatabase ||
      role.createRole ||
      role.replication ||
      role.bypassRls ||
      role.connectionLimit !== 3 ||
      !role.membership.admin ||
      role.membership.inherit ||
      role.membership.unexpected ||
      (database && !role.membership.set)
    ) {
      invariantFailure()
    }
  }
  if (
    database &&
    (database.name !== objectName || database.ownerName !== objectName)
  ) {
    invariantFailure()
  }
}

function isMaintenanceCandidate(status: TemporaryDatabaseStatus): boolean {
  return ["provisioning", "revoking", "revoke_failed"].includes(status)
}

function isReconciliationSource(
  status: TemporaryDatabaseStatus,
): status is TemporaryDatabaseReconciliationSourceStatus {
  return ["provisioning", "provisioned", "revoke_failed"].includes(status)
}

function auditFailure(): never {
  throw new TemporaryDatabaseReconciliationError("AUDIT_FAILED")
}

function invariantFailure(): never {
  throw new TemporaryDatabaseReconciliationError("INVARIANT_VIOLATION")
}
