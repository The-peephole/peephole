import type { PoolClient, QueryResultRow } from "pg"
import { describe, expect, it, vi } from "vitest"

import {
  validateTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import { PostgresTenantAdmin } from "../services/temporary-database/postgresTenantAdmin"
import type {
  CreateTemporaryDatabaseOwnership,
  TemporaryDatabaseOwnershipStore,
  TenantAdminSession,
  TenantDatabaseAdmin,
} from "../services/temporary-database/ports"
import {
  TemporaryDatabaseProvisioner,
  TemporaryDatabaseProvisioningError,
  TemporaryDatabaseRevocationError,
} from "../services/temporary-database/temporaryDatabaseProvisioner"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../types/temporaryDatabase"
import type { SqlResult } from "../services/preview-api/postgres/database"

const resourceId = validateTemporaryDatabaseResourceId(
  "r000102030405060708090a0b0c0d",
)
const objectName = `pv_${resourceId}`
const rawPassword = "RAW_APPLICATION_PASSWORD_SENTINEL"
const now = new Date("2026-09-28T00:00:00.000Z")

describe("TemporaryDatabaseProvisioner", () => {
  it("provisions in the exact durable-first order and never emits the raw password in SQL", async () => {
    const harness = compose()

    const material = await harness.provisioner.provision({
      previewId: "fullstack-preview-1",
      backendRuntimeId: "backend-runtime-1",
    })

    expect(harness.events).toEqual([
      "store:create:provisioning",
      "sql:read-session-identity",
      "sql:show-createrole-self-grant",
      "sql:show-scram-iterations",
      "sql:create-role",
      "sql:grant-set",
      "sql:create-database-disabled",
      "sql:set-role",
      "sql:revoke-public",
      "sql:enable-database",
      "sql:reset-role",
      "sql:read-session-identity",
      "store:mark-provisioned",
    ])
    expect(material).toMatchObject({
      resourceId,
      databaseName: objectName,
      roleName: objectName,
    })
    expect(material.password.reveal()).toBe(rawPassword)
    expect(harness.admin.queries.join("\n")).not.toContain(rawPassword)
    expect(harness.admin.queries.join("\n")).toContain("SCRAM-SHA-256$")
    expect(harness.admin.queries).toContain(
      `GRANT ${objectName} TO peephole_provisioner WITH SET TRUE, INHERIT FALSE`,
    )
    expect(harness.admin.queries).not.toContain("BEGIN")
    expect(harness.admin.discarded).toBe(false)
  })

  it("fails before CREATE ROLE when the initial session identity is not authenticated identity", async () => {
    const harness = compose({ currentUser: "ambient_role" })

    await expect(
      harness.provisioner.provision({
        previewId: "fullstack-preview-1",
        backendRuntimeId: "backend-runtime-1",
      }),
    ).rejects.toBeInstanceOf(TemporaryDatabaseProvisioningError)

    expect(harness.store.record?.status).toBe("provisioning")
    expect(harness.events).toEqual([
      "store:create:provisioning",
      "sql:read-session-identity",
    ])
    expect(
      harness.admin.queries.some((sql) => sql.startsWith("CREATE ROLE")),
    ).toBe(false)
  })

  it.each(["inherit", "set", "set, inherit"])(
    "fails before CREATE ROLE when createrole_self_grant is %s",
    async (createroleSelfGrant) => {
      const harness = compose({ createroleSelfGrant })

      await expect(
        harness.provisioner.provision({
          previewId: "fullstack-preview-1",
          backendRuntimeId: "backend-runtime-1",
        }),
      ).rejects.toBeInstanceOf(TemporaryDatabaseProvisioningError)

      expect(harness.store.record?.status).toBe("provisioning")
      expect(harness.events).toEqual([
        "store:create:provisioning",
        "sql:read-session-identity",
        "sql:show-createrole-self-grant",
      ])
      expect(
        harness.admin.queries.some((sql) => sql.startsWith("CREATE ROLE")),
      ).toBe(false)
    },
  )

  it.each([
    "CREATE ROLE",
    "GRANT ",
    "CREATE DATABASE",
    "REVOKE CONNECT",
    "ALTER DATABASE",
  ])(
    "keeps durable provisioning evidence when SQL fails at %s",
    async (failOn) => {
      const harness = compose({ failOn })

      await expect(
        harness.provisioner.provision({
          previewId: "fullstack-preview-1",
          backendRuntimeId: "backend-runtime-1",
        }),
      ).rejects.toBeInstanceOf(TemporaryDatabaseProvisioningError)

      expect(harness.store.record?.status).toBe("provisioning")
      expect(harness.events[0]).toBe("store:create:provisioning")
      expect(harness.events).not.toContain("store:mark-provisioned")
      if (failOn === "REVOKE CONNECT" || failOn === "ALTER DATABASE") {
        expect(harness.events).toContain("sql:reset-role")
      }
    },
  )

  it("discards a tenant session whose role cannot be reset", async () => {
    const harness = compose({ failOn: "RESET ROLE" })

    await expect(
      harness.provisioner.provision({
        previewId: "fullstack-preview-1",
        backendRuntimeId: "backend-runtime-1",
      }),
    ).rejects.toBeInstanceOf(TemporaryDatabaseProvisioningError)

    expect(harness.admin.discarded).toBe(true)
    expect(harness.store.record?.status).toBe("provisioning")
  })

  it("discards a session whose identity is wrong after RESET ROLE", async () => {
    const harness = compose({ postResetCurrentUser: "ambient_role" })

    await expect(
      harness.provisioner.provision({
        previewId: "fullstack-preview-1",
        backendRuntimeId: "backend-runtime-1",
      }),
    ).rejects.toBeInstanceOf(TemporaryDatabaseProvisioningError)

    expect(harness.events).toContain("sql:reset-role")
    expect(harness.events.at(-1)).toBe("sql:read-session-identity")
    expect(harness.admin.discarded).toBe(true)
    expect(harness.store.record?.status).toBe("provisioning")
  })

  it("revokes in the exact role-bounded order", async () => {
    const harness = compose({ initialStatus: "provisioned" })

    await harness.provisioner.revoke(resourceId)

    expect(harness.events).toEqual([
      "store:mark-revoking",
      "sql:read-session-identity",
      "sql:set-role",
      "sql:drop-database-force",
      "sql:reset-role",
      "sql:read-session-identity",
      "sql:drop-role",
      "store:mark-revoked",
    ])
    expect(harness.store.record?.status).toBe("revoked")
  })

  it("marks revoke_failed only when DROP ROLE fails after database removal", async () => {
    const harness = compose({
      initialStatus: "provisioned",
      failOn: "DROP ROLE",
    })

    await expect(harness.provisioner.revoke(resourceId)).rejects.toBeInstanceOf(
      TemporaryDatabaseRevocationError,
    )

    expect(harness.events).toEqual([
      "store:mark-revoking",
      "sql:read-session-identity",
      "sql:set-role",
      "sql:drop-database-force",
      "sql:reset-role",
      "sql:read-session-identity",
      "sql:drop-role",
      "store:mark-revoke-failed",
    ])
    expect(harness.store.record?.status).toBe("revoke_failed")
  })

  it("does not pretend revoke succeeded when DROP DATABASE fails", async () => {
    const harness = compose({
      initialStatus: "provisioned",
      failOn: "DROP DATABASE",
    })

    await expect(harness.provisioner.revoke(resourceId)).rejects.toBeInstanceOf(
      TemporaryDatabaseRevocationError,
    )

    expect(harness.events).toContain("sql:reset-role")
    expect(harness.events).not.toContain("sql:drop-role")
    expect(harness.store.record?.status).toBe("revoking")
  })

  it("fails closed on an illegal durable transition before tenant SQL", async () => {
    const harness = compose({ initialStatus: "provisioning" })

    await expect(harness.provisioner.revoke(resourceId)).rejects.toBeInstanceOf(
      TemporaryDatabaseRevocationError,
    )
    expect(harness.admin.queries).toEqual([])
  })
})

describe("PostgresTenantAdmin", () => {
  it("destroys rather than reuses a session marked unsafe", async () => {
    const release = vi.fn()
    const client = {
      query: vi.fn(),
      release,
    } as unknown as PoolClient
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn().mockResolvedValue(undefined),
    }
    const admin = new PostgresTenantAdmin({}, pool)

    await admin.withSession(async (session) => {
      session.discard()
    })

    expect(release).toHaveBeenCalledExactlyOnceWith(true)
  })
})

function compose(
  options: {
    failOn?: string
    initialStatus?: TemporaryDatabaseStatus
    sessionUser?: string
    currentUser?: string
    createroleSelfGrant?: string
    postResetCurrentUser?: string
  } = {},
) {
  const events: string[] = []
  const store = new FakeOwnershipStore(events, options.initialStatus)
  const admin = new FakeTenantAdmin(events, options)
  const provisioner = new TemporaryDatabaseProvisioner({
    ownershipStore: store,
    tenantAdmin: admin,
    createResourceId: () => resourceId,
    generatePassword: () => createOpaqueSecretValue(rawPassword),
    saltEntropy: () => new Uint8Array(16).fill(7),
    now: () => new Date(now),
  })
  return { events, store, admin, provisioner }
}

class FakeTenantAdmin implements TenantDatabaseAdmin, TenantAdminSession {
  readonly queries: string[] = []
  discarded = false
  private resetCompleted = false

  constructor(
    private readonly events: string[],
    private readonly options: {
      failOn?: string
      sessionUser?: string
      currentUser?: string
      createroleSelfGrant?: string
      postResetCurrentUser?: string
    },
  ) {}

  async withSession<T>(
    operation: (session: TenantAdminSession) => Promise<T>,
  ): Promise<T> {
    return operation(this)
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<SqlResult<Row>> {
    this.queries.push(text)
    this.events.push(`sql:${sqlEvent(text)}`)
    if (this.options.failOn && text.includes(this.options.failOn)) {
      throw new Error("Injected tenant SQL failure.")
    }
    if (text === "RESET ROLE") this.resetCompleted = true
    if (
      text ===
      "SELECT session_user AS session_user, current_user AS current_user"
    ) {
      const sessionUser = this.options.sessionUser ?? "peephole_provisioner"
      const currentUser =
        this.resetCompleted && this.options.postResetCurrentUser
          ? this.options.postResetCurrentUser
          : (this.options.currentUser ?? sessionUser)
      return result([
        { session_user: sessionUser, current_user: currentUser },
      ] as unknown as Row[])
    }
    if (text === "SHOW createrole_self_grant") {
      return result([
        {
          createrole_self_grant: this.options.createroleSelfGrant ?? "",
        },
      ] as unknown as Row[])
    }
    if (text === "SHOW scram_iterations") {
      return result([{ scram_iterations: "4096" }] as unknown as Row[])
    }
    return result([])
  }

  discard(): void {
    this.discarded = true
  }
}

class FakeOwnershipStore implements TemporaryDatabaseOwnershipStore {
  record: TemporaryDatabaseRecord | null

  constructor(
    private readonly events: string[],
    initialStatus?: TemporaryDatabaseStatus,
  ) {
    this.record = initialStatus ? makeRecord(initialStatus) : null
  }

  async createProvisioning(
    input: CreateTemporaryDatabaseOwnership,
  ): Promise<TemporaryDatabaseRecord> {
    if (this.record) throw new Error("duplicate ownership")
    this.events.push("store:create:provisioning")
    this.record = {
      resourceId: input.resourceId,
      previewId: input.previewId,
      backendRuntimeId: input.backendRuntimeId,
      status: "provisioning",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    }
    return this.record
  }

  async getByResourceId(
    candidate: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.resourceId === candidate ? this.record : null
  }

  async getByPreviewId(
    previewId: string,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.previewId === previewId ? this.record : null
  }

  async listAll(): Promise<TemporaryDatabaseRecord[]> {
    return this.record ? [this.record] : []
  }

  markProvisioned(candidate: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(
      candidate,
      "provisioning",
      "provisioned",
      at,
      "store:mark-provisioned",
    )
  }

  markRevoking(candidate: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(
      candidate,
      "provisioned",
      "revoking",
      at,
      "store:mark-revoking",
    )
  }

  markRevoked(candidate: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(
      candidate,
      "revoking",
      "revoked",
      at,
      "store:mark-revoked",
    )
  }

  markRevokeFailed(candidate: TemporaryDatabaseResourceId, at: Date) {
    return this.transition(
      candidate,
      "revoking",
      "revoke_failed",
      at,
      "store:mark-revoke-failed",
    )
  }

  private async transition(
    candidate: TemporaryDatabaseResourceId,
    from: TemporaryDatabaseStatus,
    to: TemporaryDatabaseStatus,
    at: Date,
    event: string,
  ): Promise<TemporaryDatabaseRecord> {
    if (
      !this.record ||
      this.record.resourceId !== candidate ||
      this.record.status !== from
    ) {
      throw new Error("illegal ownership transition")
    }
    this.events.push(event)
    this.record = { ...this.record, status: to, updatedAt: at.toISOString() }
    return this.record
  }
}

function result<Row extends QueryResultRow>(rows: Row[]): SqlResult<Row> {
  return { rows, rowCount: rows.length }
}

function makeRecord(status: TemporaryDatabaseStatus): TemporaryDatabaseRecord {
  return {
    resourceId,
    previewId: "fullstack-preview-1",
    backendRuntimeId: "backend-runtime-1",
    status,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

function sqlEvent(sql: string): string {
  if (sql.startsWith("SELECT session_user")) return "read-session-identity"
  if (sql === "SHOW createrole_self_grant") {
    return "show-createrole-self-grant"
  }
  if (sql === "SHOW scram_iterations") return "show-scram-iterations"
  if (sql.startsWith("CREATE ROLE")) return "create-role"
  if (sql.startsWith("GRANT ")) return "grant-set"
  if (sql.startsWith("CREATE DATABASE")) return "create-database-disabled"
  if (sql.startsWith("SET ROLE")) return "set-role"
  if (sql.startsWith("REVOKE CONNECT")) return "revoke-public"
  if (sql.startsWith("ALTER DATABASE")) return "enable-database"
  if (sql === "RESET ROLE") return "reset-role"
  if (sql.startsWith("DROP DATABASE")) return "drop-database-force"
  if (sql.startsWith("DROP ROLE")) return "drop-role"
  return "unexpected"
}
