import { describe, expect, it } from "vitest"

import {
  deriveTemporaryDatabaseObjectName,
  validateTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabaseOwnershipStore,
  TemporaryDatabasePhysicalCleaner,
  TemporaryDatabaseReconciliationSourceStatus,
  TemporaryDatabaseTenantCatalog,
  TenantPhysicalDatabase,
  TenantPhysicalRole,
  TenantPhysicalSnapshot,
  TenantResourcePresence,
} from "../services/temporary-database/ports"
import { TemporaryDatabaseOwnershipError } from "../services/temporary-database/ports"
import {
  TemporaryDatabaseOrphanReaper,
  type TemporaryDatabaseOrphanReaperOptions,
} from "../services/temporary-database/temporaryDatabaseOrphanReaper"
import { TemporaryDatabasePhysicalCleanupError } from "../services/temporary-database/temporaryDatabasePhysicalCleaner"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../types/temporaryDatabase"

const now = new Date("2026-09-28T12:00:00.000Z")
const old = "2026-09-28T10:00:00.000Z"
const recent = "2026-09-28T11:50:00.000Z"
const resourceId = validateTemporaryDatabaseResourceId(
  "r0000000000000000000000000001",
)
const otherResourceId = validateTemporaryDatabaseResourceId(
  "r0000000000000000000000000002",
)

describe("TemporaryDatabaseOrphanReaper", () => {
  it.each([
    ["row only", "provisioning", false, false, null],
    ["role before SET", "provisioning", false, true, "role"],
    ["role after SET", "provisioning", false, true, "role-set"],
    ["provisioning DB and role", "provisioning", true, true, "full"],
    ["provisioned DB and role", "provisioned", true, true, "full"],
    ["revoking DB and role", "revoking", true, true, "full"],
    ["revoke_failed role only", "revoke_failed", false, true, "role"],
    ["revoke_failed already absent", "revoke_failed", false, false, null],
  ] as const)(
    "reapAll recovers %s",
    async (_label, status, hasDatabase, hasRole, cleanupShape) => {
      const harness = compose({
        records: [record(resourceId, status)],
        databases: hasDatabase ? [database(resourceId)] : [],
        roles: hasRole
          ? [role(resourceId, { set: cleanupShape !== "role" })]
          : [],
      })

      await expect(harness.reaper.reapAll()).resolves.toEqual([resourceId])
      expect(harness.store.status(resourceId)).toBe("revoked")
      expect(harness.cleaner.events).toEqual(
        cleanupShape === "full"
          ? [`full:${resourceId}`]
          : cleanupShape
            ? [`role:${resourceId}`]
            : [],
      )
      expect(await harness.catalog.inspectResource(resourceId)).toEqual({
        database: false,
        role: false,
      })
    },
  )

  it("treats a clean revoked row as an idempotent no-op", async () => {
    const harness = compose({ records: [record(resourceId, "revoked")] })
    await expect(harness.reaper.reapAll()).resolves.toEqual([])
    expect(harness.cleaner.events).toEqual([])
  })

  it.each([
    [
      "revoked role residue",
      [record(resourceId, "revoked")],
      [],
      [role(resourceId)],
    ],
    [
      "revoked DB residue",
      [record(resourceId, "revoked")],
      [database(resourceId)],
      [role(resourceId)],
    ],
    [
      "DB without role",
      [record(resourceId, "provisioning")],
      [database(resourceId)],
      [],
    ],
    [
      "wrong DB owner",
      [record(resourceId, "provisioning")],
      [database(resourceId, { ownerName: "other_owner" })],
      [role(resourceId)],
    ],
    [
      "DB without SET",
      [record(resourceId, "provisioning")],
      [database(resourceId)],
      [role(resourceId, { set: false })],
    ],
    [
      "unexpected INHERIT",
      [record(resourceId, "provisioning")],
      [],
      [role(resourceId, { inherit: true })],
    ],
    [
      "elevated role",
      [record(resourceId, "provisioning")],
      [],
      [role(resourceId, { superuser: true })],
    ],
    [
      "unexpected membership",
      [record(resourceId, "provisioning")],
      [],
      [role(resourceId, { unexpected: true })],
    ],
    ["unowned valid role", [], [], [role(resourceId)]],
    ["unowned valid DB", [], [database(resourceId)], []],
    ["malformed pv role", [], [], [malformedRole("pv_not_valid")]],
    ["malformed pv DB", [], [malformedDatabase("pv_not_valid")], []],
    [
      "revoke_failed with DB",
      [record(resourceId, "revoke_failed")],
      [database(resourceId)],
      [role(resourceId)],
    ],
    [
      "provisioned without physical state",
      [record(resourceId, "provisioned")],
      [],
      [],
    ],
  ] as const)(
    "fails closed for %s",
    async (_label, records, databases, roles) => {
      const harness = compose({
        records: [...records],
        databases: [...databases],
        roles: [...roles],
      })
      await expect(harness.reaper.reapAll()).rejects.toMatchObject({
        code: expect.stringMatching(/AUDIT_FAILED|INVARIANT_VIOLATION/),
      })
      expect(harness.cleaner.events).toEqual([])
    },
  )

  it("audits the complete snapshot before mutating any safe resource", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning")],
      roles: [role(resourceId), role(otherResourceId)],
    })

    await expect(harness.reaper.reapAll()).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    })
    expect(harness.store.status(resourceId)).toBe("provisioning")
    expect(harness.cleaner.events).toEqual([])
  })

  it.each([
    [false, "revoking"],
    [true, "revoke_failed"],
  ] as const)(
    "preserves phase-aware evidence when full cleanup fails (databaseRemoved=%s)",
    async (databaseRemoved, expectedStatus) => {
      const harness = compose({
        records: [record(resourceId, "provisioning")],
        databases: [database(resourceId)],
        roles: [role(resourceId)],
        cleanerFailure: { databaseRemoved },
      })

      await expect(harness.reaper.reapAll()).rejects.toMatchObject({
        code: "CLEANUP_FAILED",
      })
      expect(harness.store.status(resourceId)).toBe(expectedStatus)
    },
  )

  it("marks role-only cleanup failure revoke_failed", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning")],
      roles: [role(resourceId, { set: false })],
      cleanerFailure: { databaseRemoved: true },
    })
    await expect(harness.reaper.reapAll()).rejects.toMatchObject({
      code: "CLEANUP_FAILED",
    })
    expect(harness.store.status(resourceId)).toBe("revoke_failed")
  })

  it("requires catalog-proven absence before marking revoked", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning")],
      roles: [role(resourceId)],
      retainAfterCleanup: true,
    })

    await expect(harness.reaper.reapAll()).rejects.toMatchObject({
      code: "CLEANUP_FAILED",
    })
    expect(harness.store.status(resourceId)).toBe("revoke_failed")
  })

  it("does not mutate physical state when the recovery CAS fails", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning")],
      roles: [role(resourceId)],
      rejectClaim: true,
    })

    await expect(harness.reaper.reapAll()).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    })
    expect(harness.cleaner.events).toEqual([])
    expect(harness.store.status(resourceId)).toBe("provisioning")
  })

  it("re-reads an already-revoking row immediately before cleanup", async () => {
    const harness = compose({
      records: [record(resourceId, "revoking")],
      roles: [role(resourceId)],
      statusOnRead: "revoked",
    })
    await expect(harness.reaper.reapAll()).rejects.toMatchObject({
      code: "TRANSITION_REJECTED",
    })
    expect(harness.cleaner.events).toEqual([])
  })

  it("is idempotent after a successful startup reconciliation", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning")],
      roles: [role(resourceId)],
    })
    await expect(harness.reaper.reapAll()).resolves.toEqual([resourceId])
    await expect(harness.reaper.reapAll()).resolves.toEqual([])
    expect(harness.cleaner.events).toEqual([`role:${resourceId}`])
  })

  it.each([
    ["provisioning", recent, false],
    ["provisioning", old, true],
    ["revoking", recent, false],
    ["revoking", old, true],
    ["revoke_failed", recent, false],
    ["revoke_failed", old, true],
    ["provisioned", old, false],
  ] as const)(
    "maintenance status=%s updatedAt=%s reconciles=%s",
    async (status, updatedAt, shouldReconcile) => {
      const hasDatabase = status === "provisioned"
      const harness = compose({
        records: [record(resourceId, status, updatedAt)],
        databases: hasDatabase ? [database(resourceId)] : [],
        roles: hasDatabase ? [role(resourceId)] : [],
      })
      await expect(harness.reaper.reap()).resolves.toEqual(
        shouldReconcile ? [resourceId] : [],
      )
      expect(harness.store.status(resourceId)).toBe(
        shouldReconcile ? "revoked" : status,
      )
    },
  )

  it("reapAll ignores age for non-terminal rows", async () => {
    const harness = compose({
      records: [record(resourceId, "provisioning", recent)],
    })
    await expect(harness.reaper.reapAll()).resolves.toEqual([resourceId])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxAgeMs %s",
    (maxAgeMs) => {
      expect(() => compose({ maxAgeMs })).toThrow(/maxAgeMs/)
    },
  )

  it.each([
    "not-a-date",
    "2026-02-30T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
  ])(
    "fails closed for malformed or impossible updatedAt %s",
    async (updatedAt) => {
      const harness = compose({
        records: [record(resourceId, "provisioning", updatedAt)],
      })
      await expect(harness.reaper.reapAll()).rejects.toMatchObject({
        code: "INVARIANT_VIOLATION",
      })
      expect(harness.cleaner.events).toEqual([])
    },
  )
})

function compose(
  options: {
    records?: TemporaryDatabaseRecord[]
    databases?: TenantPhysicalDatabase[]
    roles?: TenantPhysicalRole[]
    cleanerFailure?: { databaseRemoved: boolean }
    retainAfterCleanup?: boolean
    rejectClaim?: boolean
    statusOnRead?: TemporaryDatabaseStatus
    maxAgeMs?: number
  } = {},
) {
  const store = new FakeStore(
    options.records ?? [],
    options.rejectClaim,
    options.statusOnRead,
  )
  const catalog = new FakeCatalog(options.databases ?? [], options.roles ?? [])
  const cleaner = new FakeCleaner(
    catalog,
    options.cleanerFailure,
    options.retainAfterCleanup,
  )
  const reaperOptions: TemporaryDatabaseOrphanReaperOptions = {
    ownershipStore: store,
    tenantCatalog: catalog,
    physicalCleaner: cleaner,
    now: () => new Date(now),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  }
  const reaper = new TemporaryDatabaseOrphanReaper(reaperOptions)
  return { reaper, store, catalog, cleaner }
}

class FakeStore implements TemporaryDatabaseOwnershipStore {
  private readonly records: Map<
    TemporaryDatabaseResourceId,
    TemporaryDatabaseRecord
  >

  constructor(
    records: TemporaryDatabaseRecord[],
    private readonly rejectClaim = false,
    private readonly statusOnRead?: TemporaryDatabaseStatus,
  ) {
    this.records = new Map(records.map((item) => [item.resourceId, item]))
  }

  status(id: TemporaryDatabaseResourceId): TemporaryDatabaseStatus | undefined {
    return this.records.get(id)?.status
  }

  async listAll(): Promise<TemporaryDatabaseRecord[]> {
    return [...this.records.values()]
  }

  async getByResourceId(
    id: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null> {
    const item = this.records.get(id)
    return item && this.statusOnRead
      ? { ...item, status: this.statusOnRead }
      : (item ?? null)
  }

  async beginReconciliation(
    id: TemporaryDatabaseResourceId,
    expected: TemporaryDatabaseReconciliationSourceStatus,
    at: Date,
  ): Promise<TemporaryDatabaseRecord> {
    if (this.rejectClaim)
      throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
    return this.transition(id, expected, "revoking", at)
  }

  markRevoked(id: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(id, "revoking", "revoked", at)
  }

  markRevokeFailed(id: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(id, "revoking", "revoke_failed", at)
  }

  markProvisioned(id: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(id, "provisioning", "provisioned", at)
  }

  markRevoking(id: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(id, "provisioned", "revoking", at)
  }

  async createProvisioning(): Promise<TemporaryDatabaseRecord> {
    throw new Error("not used")
  }

  async getByPreviewId(): Promise<TemporaryDatabaseRecord | null> {
    return null
  }

  private async transition(
    id: TemporaryDatabaseResourceId,
    expected: TemporaryDatabaseStatus,
    target: TemporaryDatabaseStatus,
    at: Date,
  ): Promise<TemporaryDatabaseRecord> {
    const item = this.records.get(id)
    if (!item || item.status !== expected) {
      throw new TemporaryDatabaseOwnershipError("TRANSITION_REJECTED")
    }
    const next = { ...item, status: target, updatedAt: at.toISOString() }
    this.records.set(id, next)
    return next
  }
}

class FakeCatalog implements TemporaryDatabaseTenantCatalog {
  constructor(
    readonly databases: TenantPhysicalDatabase[],
    readonly roles: TenantPhysicalRole[],
  ) {}

  async snapshot(): Promise<TenantPhysicalSnapshot> {
    return {
      provisioningRole: "peephole_provisioner",
      databases: [...this.databases],
      roles: [...this.roles],
    }
  }

  async inspectResource(
    id: TemporaryDatabaseResourceId,
  ): Promise<TenantResourcePresence> {
    return {
      database: this.databases.some((item) => item.resourceId === id),
      role: this.roles.some((item) => item.resourceId === id),
    }
  }
}

class FakeCleaner implements TemporaryDatabasePhysicalCleaner {
  readonly events: string[] = []

  constructor(
    private readonly catalog: FakeCatalog,
    private readonly failure?: { databaseRemoved: boolean },
    private readonly retainAfterCleanup = false,
  ) {}

  async cleanupFull(id: TemporaryDatabaseResourceId): Promise<void> {
    this.events.push(`full:${id}`)
    if (this.failure) {
      if (this.failure.databaseRemoved) this.removeDatabase(id)
      throw new TemporaryDatabasePhysicalCleanupError(
        this.failure.databaseRemoved,
      )
    }
    if (!this.retainAfterCleanup) {
      this.removeDatabase(id)
      this.removeRole(id)
    }
  }

  async cleanupRoleOnly(id: TemporaryDatabaseResourceId): Promise<void> {
    this.events.push(`role:${id}`)
    if (this.failure) {
      throw new TemporaryDatabasePhysicalCleanupError(true)
    }
    if (!this.retainAfterCleanup) this.removeRole(id)
  }

  private removeDatabase(id: TemporaryDatabaseResourceId): void {
    const index = this.catalog.databases.findIndex(
      (item) => item.resourceId === id,
    )
    if (index >= 0) this.catalog.databases.splice(index, 1)
  }

  private removeRole(id: TemporaryDatabaseResourceId): void {
    const index = this.catalog.roles.findIndex((item) => item.resourceId === id)
    if (index >= 0) this.catalog.roles.splice(index, 1)
  }
}

function record(
  id: TemporaryDatabaseResourceId,
  status: TemporaryDatabaseStatus,
  updatedAt = old,
): TemporaryDatabaseRecord {
  return {
    resourceId: id,
    previewId: `preview-${id}`,
    backendRuntimeId: `runtime-${id}`,
    status,
    createdAt: old,
    updatedAt,
  }
}

function database(
  id: TemporaryDatabaseResourceId,
  overrides: Partial<TenantPhysicalDatabase> = {},
): TenantPhysicalDatabase {
  const name = deriveTemporaryDatabaseObjectName(id)
  return {
    name,
    resourceId: id,
    ownerName: name,
    allowsConnections: true,
    ...overrides,
  }
}

function role(
  id: TemporaryDatabaseResourceId,
  overrides: {
    set?: boolean
    inherit?: boolean
    unexpected?: boolean
    superuser?: boolean
  } = {},
): TenantPhysicalRole {
  return {
    name: deriveTemporaryDatabaseObjectName(id),
    resourceId: id,
    canLogin: true,
    superuser: overrides.superuser ?? false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    connectionLimit: 3,
    membership: {
      admin: true,
      set: overrides.set ?? true,
      inherit: overrides.inherit ?? false,
      unexpected: overrides.unexpected ?? false,
    },
  }
}

function malformedRole(name: string): TenantPhysicalRole {
  return { ...role(resourceId), name, resourceId: null }
}

function malformedDatabase(name: string): TenantPhysicalDatabase {
  return { ...database(resourceId), name, resourceId: null }
}
