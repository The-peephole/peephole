import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../core/backendDatabase/databaseUrl"
import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"

import type { PostgresDatabase } from "../services/preview-api/postgres/database"
import {
  TmpfsDatabaseCredentialFilesystem,
  type DatabaseCredentialFilesystem,
  type TmpfsDatabaseCredentialFilesystemOptions,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { DatabaseCredentialOrphanReaper } from "../services/preview-worker/gvisor/databaseCredentialOrphanReaper"
import {
  assertTenantProvisioningCapability,
  initializeProductionTemporaryDatabaseRuntime,
  temporaryDatabaseBackendDependencies,
  temporaryDatabaseMaintenanceTasks,
  TemporaryDatabasesDisabledWithOwnedResourcesError,
  type ProductionTemporaryDatabaseRuntime,
} from "../services/production/temporaryDatabaseRuntime"
import type {
  TemporaryDatabaseOwnershipStore,
  TenantAdminSession,
  TenantDatabaseAdmin,
} from "../services/temporary-database/ports"
import { TemporaryDatabaseProvisioner } from "../services/temporary-database/temporaryDatabaseProvisioner"
import { PREVIEW_GENERATED_SECRET_NAMES } from "../types/backendRuntimeSecrets"
import type { TemporaryDatabaseStatus } from "../types/temporaryDatabase"

// Placeholder only; never a real credential.
const PROVISIONING_URL =
  "postgresql://m11_provisioner:placeholder-secret@%2Frun%2Fpostgresql:5433/tenant_admin"

const BASE_OPTIONS = {
  controlDatabase: {} as PostgresDatabase,
  bundlesRootDir: "/var/lib/peephole/jobs",
  artifactStorageDir: "/var/lib/peephole/artifacts",
  generatedSecretRootDir: "/run/peephole/secrets",
  orphanReaperMaxAgeMs: 30 * 60_000,
}

const ENABLED = {
  enabled: true as const,
  provisioningUrl: PROVISIONING_URL,
  credentialRootDir: "/run/peephole/db-credentials",
}

function fakeCredentialFilesystem(): DatabaseCredentialFilesystem {
  return {
    rootDir: ENABLED.credentialRootDir,
  } as unknown as DatabaseCredentialFilesystem
}

function ownershipRecord(status: TemporaryDatabaseStatus) {
  return {
    resourceId: "pv-placeholder",
    previewId: "fullstack-placeholder",
    backendRuntimeId: "backend-placeholder",
    status,
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  }
}

function harness(
  overrides: {
    capability?: () => Promise<void>
    credentialCapability?: () => Promise<void>
    reapAll?: () => Promise<unknown>
    credentialReapAll?: () => Promise<unknown>
    ownershipStatuses?: TemporaryDatabaseStatus[]
    credentialRootExists?: boolean
  } = {},
) {
  const events: string[] = []
  let adminClosed = 0
  const ownershipStore = {
    listAll: async () => {
      events.push("ownership listAll")
      return (overrides.ownershipStatuses ?? []).map(ownershipRecord)
    },
  } as unknown as TemporaryDatabaseOwnershipStore
  const filesystem = fakeCredentialFilesystem()
  const tenantAdmin: TenantDatabaseAdmin & { close(): Promise<void> } = {
    withSession: () => Promise.reject(new Error("unused")),
    close: async () => {
      adminClosed += 1
      events.push("tenant admin closed")
    },
  }
  const dependencies = {
    createOwnershipStore: () => ownershipStore,
    createCredentialFilesystem: (options: {
      rootDir?: string
      forbiddenRoots?: readonly string[]
    }) => {
      events.push(
        `credential filesystem ${String(options.rootDir)} forbids ${String(options.forbiddenRoots?.join(","))}`,
      )
      return filesystem
    },
    credentialRootExists: async (credentialRootDir: string) => {
      events.push(`credential root check ${credentialRootDir}`)
      return overrides.credentialRootExists ?? false
    },
    ensureCredentialCapability: async (options: {
      credentialRootDir: string
      prepareDirectory?: (candidate: string) => Promise<void>
    }) => {
      events.push(
        `credential capability ${options.credentialRootDir}${options.prepareDirectory ? " (validate only)" : ""}`,
      )
      await overrides.credentialCapability?.()
    },
    createTenantAdmin: (connectionString: string) => {
      events.push(
        connectionString === PROVISIONING_URL
          ? "tenant admin created with configured URL"
          : "tenant admin created with an unexpected URL",
      )
      return tenantAdmin
    },
    assertTenantCapability: async (admin: TenantDatabaseAdmin) => {
      events.push(
        admin === tenantAdmin ? "tenant capability" : "wrong tenant admin",
      )
      await overrides.capability?.()
    },
    createOrphanReaper: () => ({
      reapAll: async () => {
        events.push("temporary database reapAll")
        return overrides.reapAll?.()
      },
      reap: async () => {
        events.push("temporary database reap")
      },
    }),
    createCredentialOrphanReaper: (options: {
      rootDir?: string
      filesystem?: DatabaseCredentialFilesystem
    }) => ({
      reapAll: async () => {
        events.push(
          options.filesystem === filesystem
            ? `credential reapAll ${String(options.rootDir)}`
            : "credential reapAll with a different filesystem",
        )
        return overrides.credentialReapAll?.()
      },
      reap: async () => {
        events.push("credential reap")
      },
    }),
  }
  return {
    events,
    dependencies,
    filesystem,
    adminClosed: () => adminClosed,
  }
}

describe("initializeProductionTemporaryDatabaseRuntime", () => {
  const DISABLED = {
    enabled: false as const,
    credentialRootDir: ENABLED.credentialRootDir,
  }
  const FILESYSTEM_EVENT =
    "credential filesystem /run/peephole/db-credentials forbids /var/lib/peephole/jobs,/var/lib/peephole/artifacts,/run/peephole/secrets"
  const ROOT_CHECK_EVENT = "credential root check /run/peephole/db-credentials"
  const CLEANUP_EVENTS = [
    "credential capability /run/peephole/db-credentials (validate only)",
    "credential reapAll /run/peephole/db-credentials",
  ]

  /** Credential-side and ownership dependencies stay real fakes; every
   * tenant-side dependency throws, proving none is touched while disabled. */
  function disabledDependencies(
    statuses: TemporaryDatabaseStatus[],
    overrides: Parameters<typeof harness>[0] = {},
  ) {
    const test = harness({ ...overrides, ownershipStatuses: statuses })
    const fail = () => {
      throw new Error("must not be called while disabled")
    }
    return {
      events: test.events,
      dependencies: {
        ...test.dependencies,
        createTenantAdmin: fail,
        assertTenantCapability: fail,
        createOrphanReaper: fail,
      },
    }
  }

  async function initializeDisabled(
    test: ReturnType<typeof disabledDependencies>,
  ) {
    try {
      return {
        runtime: await initializeProductionTemporaryDatabaseRuntime(
          { ...BASE_OPTIONS, config: DISABLED },
          test.dependencies,
        ),
        error: undefined,
      }
    } catch (error) {
      return { runtime: undefined, error: error as Error }
    }
  }

  it.each([
    ["no ownership rows", []],
    ["only revoked rows", ["revoked", "revoked"]],
  ] as const)(
    "while disabled with an absent credential root and %s, creates no root and no tenant runtime",
    async (_name, statuses) => {
      const test = disabledDependencies([...statuses])

      const { runtime, error } = await initializeDisabled(test)

      expect(error).toBeUndefined()
      expect(runtime).toBeNull()
      expect(test.events).toEqual([
        FILESYSTEM_EVENT,
        ROOT_CHECK_EVENT,
        "ownership listAll",
      ])
    },
  )

  it("while disabled, cleans a leftover credential under revoked-only ownership, then allows startup", async () => {
    const test = disabledDependencies(["revoked"], {
      credentialRootExists: true,
    })

    const { runtime, error } = await initializeDisabled(test)

    expect(error).toBeUndefined()
    expect(runtime).toBeNull()
    expect(test.events).toEqual([
      FILESYSTEM_EVENT,
      ROOT_CHECK_EVENT,
      ...CLEANUP_EVENTS,
      "ownership listAll",
    ])
  })

  it.each([
    "provisioning",
    "provisioned",
    "revoking",
    "revoke_failed",
  ] as const)(
    "refuses startup while disabled with a non-terminal %s row, after credential cleanup and without touching the tenant cluster",
    async (status) => {
      for (const credentialRootExists of [false, true]) {
        const test = disabledDependencies(["revoked", status, status], {
          credentialRootExists,
        })

        const { error } = await initializeDisabled(test)

        expect(error).toBeInstanceOf(
          TemporaryDatabasesDisabledWithOwnedResourcesError,
        )
        expect(error?.message).toContain(`${status}=2`)
        expect(error?.message).not.toContain("revoked=")
        expect(error?.message).toContain("PEEPHOLE_TEMPORARY_DATABASES=1")
        expect(error?.message).not.toMatch(/placeholder|postgres(ql)?:\/\//)
        expect(test.events).toEqual([
          FILESYSTEM_EVENT,
          ROOT_CHECK_EVENT,
          ...(credentialRootExists ? CLEANUP_EVENTS : []),
          "ownership listAll",
        ])
      }
    },
  )

  it.each([
    [
      "an unsafe or non-tmpfs root",
      {
        credentialCapability: () =>
          Promise.reject(new Error("Database-credential root is not tmpfs.")),
      },
      /not tmpfs/,
    ],
    [
      "a credential cleanup failure",
      {
        credentialReapAll: () =>
          Promise.reject(new Error("credential removal failed")),
      },
      /credential removal failed/,
    ],
  ])(
    "refuses startup while disabled on %s, before reading ownership",
    async (_name, override, pattern) => {
      const test = disabledDependencies(["revoked"], {
        ...override,
        credentialRootExists: true,
      })

      const { error } = await initializeDisabled(test)

      expect(error?.message).toMatch(pattern)
      expect(test.events).not.toContain("ownership listAll")
    },
  )

  it("proves capabilities, then reconciles databases and credentials before returning", async () => {
    const test = harness()

    const runtime = await initializeProductionTemporaryDatabaseRuntime(
      { ...BASE_OPTIONS, config: ENABLED },
      test.dependencies,
    )

    expect(test.events).toEqual([
      "credential filesystem /run/peephole/db-credentials forbids /var/lib/peephole/jobs,/var/lib/peephole/artifacts,/run/peephole/secrets",
      "credential capability /run/peephole/db-credentials",
      "tenant admin created with configured URL",
      "tenant capability",
      "temporary database reapAll",
      "credential reapAll /run/peephole/db-credentials",
    ])
    expect(runtime?.provisioner).toBeInstanceOf(TemporaryDatabaseProvisioner)
    expect(runtime?.credentialFilesystem).toBe(test.filesystem)
    expect(JSON.stringify(runtime)).not.toContain("placeholder-secret")

    await runtime?.close()
    expect(test.adminClosed()).toBe(1)
  })

  it("rejects before creating a tenant session when the credential root is unusable", async () => {
    const test = harness({
      credentialCapability: () =>
        Promise.reject(new Error("Database-credential root is not tmpfs.")),
    })

    await expect(
      initializeProductionTemporaryDatabaseRuntime(
        { ...BASE_OPTIONS, config: ENABLED },
        test.dependencies,
      ),
    ).rejects.toThrow(/not tmpfs/)
    expect(test.events).not.toContain(
      "tenant admin created with configured URL",
    )
  })

  it("rejects, closes the tenant pool, and skips reconciliation when the tenant capability fails", async () => {
    const test = harness({
      capability: () => Promise.reject(new Error("capability failed")),
    })

    await expect(
      initializeProductionTemporaryDatabaseRuntime(
        { ...BASE_OPTIONS, config: ENABLED },
        test.dependencies,
      ),
    ).rejects.toThrow(/capability failed/)
    expect(test.adminClosed()).toBe(1)
    expect(test.events).not.toContain("temporary database reapAll")
  })

  it.each([
    [
      "temporary database",
      { reapAll: () => Promise.reject(new Error("CATALOG_UNAVAILABLE")) },
    ],
    [
      "credential",
      {
        credentialReapAll: () =>
          Promise.reject(new Error("credential reap failed")),
      },
    ],
  ])(
    "fails startup closed when %s startup reconciliation fails",
    async (_name, override) => {
      const test = harness(override)

      await expect(
        initializeProductionTemporaryDatabaseRuntime(
          { ...BASE_OPTIONS, config: ENABLED },
          test.dependencies,
        ),
      ).rejects.toThrow()
      expect(test.adminClosed()).toBe(1)
    },
  )
})

describe("production temporary-database composition helpers", () => {
  it("supplies the backend composition with neither dependency while disabled and both while enabled", async () => {
    expect(temporaryDatabaseBackendDependencies(null)).toEqual({})

    const test = harness()
    const runtime = await initializeProductionTemporaryDatabaseRuntime(
      { ...BASE_OPTIONS, config: ENABLED },
      test.dependencies,
    )
    expect(temporaryDatabaseBackendDependencies(runtime)).toEqual({
      temporaryDatabaseProvisioner: runtime?.provisioner,
      databaseCredentialFilesystem: test.filesystem,
    })
  })

  it("adds both maintenance reapers only while enabled", async () => {
    expect(temporaryDatabaseMaintenanceTasks(null)).toEqual([])

    const test = harness()
    const runtime = (await initializeProductionTemporaryDatabaseRuntime(
      { ...BASE_OPTIONS, config: ENABLED },
      test.dependencies,
    )) as ProductionTemporaryDatabaseRuntime
    test.events.length = 0

    await Promise.all(temporaryDatabaseMaintenanceTasks(runtime))
    expect(test.events).toEqual(["temporary database reap", "credential reap"])
  })
})

describe("assertTenantProvisioningCapability", () => {
  const HEALTHY = {
    version: 180_006,
    port: "5433",
    listen_addresses: "192.168.253.1",
    unix_socket: true,
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: true,
    rolcreaterole: true,
    rolreplication: false,
    rolbypassrls: false,
  }

  function adminReturning(
    row: Record<string, unknown> | undefined,
    sessionError?: Error,
  ): TenantDatabaseAdmin {
    const session: TenantAdminSession = {
      query: async <Row>(text: string) => {
        if (sessionError) throw sessionError
        if (text.includes("session_user")) {
          return {
            rows: [
              {
                session_user: "m11_provisioner",
                current_user: "m11_provisioner",
              },
            ] as unknown as Row[],
            rowCount: 1,
          }
        }
        if (text.includes("createrole_self_grant")) {
          return {
            rows: [{ createrole_self_grant: "" }] as unknown as Row[],
            rowCount: 1,
          }
        }
        return {
          rows: (row ? [row] : []) as unknown as Row[],
          rowCount: row ? 1 : 0,
        }
      },
      discard: () => undefined,
    } as TenantAdminSession
    return { withSession: (operation) => operation(session) }
  }

  it("accepts the locked PostgreSQL 18 tenant endpoint and role policy", async () => {
    await expect(
      assertTenantProvisioningCapability(adminReturning(HEALTHY)),
    ).resolves.toBeUndefined()
  })

  it.each([
    [
      "a TCP session",
      { unix_socket: false },
      /local Unix-domain socket, not TCP/,
    ],
    [
      "an unknown transport",
      { unix_socket: null },
      /local Unix-domain socket, not TCP/,
    ],
    ["PostgreSQL 16", { version: 160_004 }, /PostgreSQL 18 is required/],
    [
      "the control-plane port",
      { port: "5432" },
      /must listen only on 192\.168\.253\.1:5433/,
    ],
    ["a broader listener", { listen_addresses: "*" }, /must listen only on/],
    ["a superuser", { rolsuper: true }, /NOSUPERUSER/],
    ["no CREATEDB", { rolcreatedb: false }, /CREATEDB/],
    ["no CREATEROLE", { rolcreaterole: false }, /CREATEROLE/],
    ["REPLICATION", { rolreplication: true }, /NOREPLICATION/],
    ["BYPASSRLS", { rolbypassrls: true }, /NOBYPASSRLS/],
    ["NOLOGIN", { rolcanlogin: false }, /LOGIN/],
  ])("rejects %s", async (_name, override, pattern) => {
    await expect(
      assertTenantProvisioningCapability(
        adminReturning({ ...HEALTHY, ...override }),
      ),
    ).rejects.toThrow(pattern)
  })

  it("rejects a missing provisioning role row", async () => {
    await expect(
      assertTenantProvisioningCapability(adminReturning(undefined)),
    ).rejects.toThrow(/provisioning role not found/)
  })

  it("reports only a SQLSTATE, never driver text that could carry the connection string", async () => {
    const driverError = Object.assign(
      new Error(
        `connection to ${PROVISIONING_URL} failed: password placeholder-secret rejected`,
      ),
      { code: "28P01" },
    )

    let message = ""
    try {
      await assertTenantProvisioningCapability(
        adminReturning(HEALTHY, driverError),
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      expect((error as Error).cause).toBeUndefined()
    }
    expect(message).toMatch(/SQLSTATE 28P01/)
    expect(message).not.toContain("placeholder-secret")
    expect(message).not.toContain("m11_provisioner")
  })
})

describe("M11-E1 production wiring boundaries", () => {
  async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map((entry) => {
        const candidate = path.join(directory, entry.name)
        if (entry.isDirectory()) return sourceFiles(candidate)
        return Promise.resolve(candidate.endsWith(".ts") ? [candidate] : [])
      }),
    )
    return nested.flat()
  }

  it("reads the tenant provisioning credential only in production config", async () => {
    const files = (
      await Promise.all(["core", "types", "services"].map(sourceFiles))
    ).flat()
    const readers: string[] = []
    for (const file of files) {
      if (
        (await readFile(file, "utf8")).includes(
          "PEEPHOLE_TENANT_DB_PROVISIONING_URL",
        )
      ) {
        readers.push(
          path.relative(process.cwd(), file).split(path.sep).join("/"),
        )
      }
    }

    expect(readers).toEqual(["services/production/config.ts"])
  })

  it("keeps DATABASE_URL out of the M10 generated-secret allowlist", () => {
    expect([...PREVIEW_GENERATED_SECRET_NAMES]).toEqual([
      "JWT_SECRET",
      "SESSION_SECRET",
      "COOKIE_SECRET",
      "CSRF_SECRET",
    ])
  })

  it("exposes only the two paired dependencies to backend composition", async () => {
    const test = harness()
    const runtime = await initializeProductionTemporaryDatabaseRuntime(
      { ...BASE_OPTIONS, config: ENABLED },
      test.dependencies,
    )

    expect(
      Object.keys(temporaryDatabaseBackendDependencies(runtime)).sort(),
    ).toEqual(["databaseCredentialFilesystem", "temporaryDatabaseProvisioner"])
  })
})

describe("disabled-mode credential rollback cleanup (real filesystem)", () => {
  // The supervisor's ordered teardown can fail to remove the credential file
  // (recorded as a cleanup error) and still revoke the database afterwards,
  // leaving: ownership `revoked`, DB/role absent, plaintext credential file
  // present. Startup with the feature disabled must still remove it.
  const MARKER = "RollbackCredMarker_4Kq8"
  const RESOURCE_ID = mintTemporaryDatabaseResourceId(() =>
    new Uint8Array(14).fill(7),
  )
  const OBJECT_NAME = deriveTemporaryDatabaseObjectName(RESOURCE_ID)
  let parentDir: string
  let credentialRoot: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), "peephole-db-rollback-"))
    credentialRoot = path.join(parentDir, "db-credentials")
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function realFilesystem(options: TmpfsDatabaseCredentialFilesystemOptions) {
    return new TmpfsDatabaseCredentialFilesystem({
      ...options,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
  }

  async function leaveStaleCredential(runtimeId: string) {
    await realFilesystem({ rootDir: credentialRoot }).create({
      runtimeId,
      resourceId: RESOURCE_ID,
      databaseUrl: createOpaqueSecretValue(
        `postgresql://${OBJECT_NAME}:${MARKER}@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/${OBJECT_NAME}`,
      ),
    })
  }

  function startDisabled(
    statuses: TemporaryDatabaseStatus[],
    overrides: { ensureCredentialCapability?: "real" } = {},
  ) {
    const fail = () => {
      throw new Error("tenant dependency must not be called while disabled")
    }
    return initializeProductionTemporaryDatabaseRuntime(
      {
        ...BASE_OPTIONS,
        config: { enabled: false, credentialRootDir: credentialRoot },
      },
      {
        createOwnershipStore: () =>
          ({
            listAll: async () => statuses.map(ownershipRecord),
          }) as unknown as TemporaryDatabaseOwnershipStore,
        createCredentialFilesystem: realFilesystem,
        // The real root check and real orphan reaper run; only the findmnt
        // tmpfs probe is replaced, since test temp dirs are not tmpfs.
        ...(overrides.ensureCredentialCapability === "real"
          ? {}
          : { ensureCredentialCapability: async () => undefined }),
        createCredentialOrphanReaper: (options) =>
          new DatabaseCredentialOrphanReaper({
            ...options,
            verifyMemoryBackedRoot: async () => undefined,
          }),
        createTenantAdmin: fail,
        assertTenantCapability: fail,
        createOrphanReaper: fail,
      },
    )
  }

  it("does not create an absent root", async () => {
    await expect(startDisabled([])).resolves.toBeNull()
    await expect(lstat(credentialRoot)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("removes a credential left behind by a revoked database, then starts", async () => {
    await leaveStaleCredential("runtime-stale-1")
    expect(await readdir(credentialRoot)).toEqual(["runtime-stale-1"])

    await expect(startDisabled(["revoked"])).resolves.toBeNull()
    expect(await readdir(credentialRoot)).toEqual([])
  })

  it("removes the stale credential but still refuses startup on non-terminal ownership, without leaking it", async () => {
    await leaveStaleCredential("runtime-stale-2")

    let message = ""
    try {
      await startDisabled(["revoked", "provisioned"])
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/provisioned=1/)
    expect(message).not.toContain(MARKER)
    expect(message).not.toMatch(/postgres(ql)?:\/\//)
    expect(await readdir(credentialRoot)).toEqual([])
  })

  it("refuses startup when the configured root exists but is not a directory", async () => {
    await mkdir(parentDir, { recursive: true })
    await writeFile(credentialRoot, "not a directory")

    await expect(
      startDisabled(["revoked"], { ensureCredentialCapability: "real" }),
    ).rejects.toThrow(/Database-credential root must be a regular directory/)
  })
})
