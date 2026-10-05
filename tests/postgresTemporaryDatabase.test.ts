import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client, Pool, type QueryResultRow } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { createPostgresScramSha256Verifier } from "../core/backendDatabase/scramVerifier"
import { createFullStackPreviewId } from "../services/fullstack-preview-api/id"
import { readPostgresConfig } from "../services/preview-api/postgres/config"
import { PgPoolDatabase } from "../services/preview-api/postgres/database"
import { applyPostgresMigrations } from "../services/preview-api/postgres/migrate"
import { PostgresTemporaryDatabaseOwnershipStore } from "../services/temporary-database/postgresOwnershipStore"
import { PostgresTenantAdmin } from "../services/temporary-database/postgresTenantAdmin"
import type {
  TenantAdminSession,
  TenantDatabaseAdmin,
} from "../services/temporary-database/ports"
import { TemporaryDatabaseProvisioner } from "../services/temporary-database/temporaryDatabaseProvisioner"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import type { BackendRuntimeProcessStarter } from "../services/backend-runtime-worker/ports"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type { TemporaryDatabaseCredentialMaterial } from "../types/temporaryDatabase"
import type { SqlResult } from "../services/preview-api/postgres/database"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const clusterGlobalAllowed =
  process.env.PEEPHOLE_POSTGRES_ALLOW_CLUSTER_GLOBAL === "1"
// This suite creates disposable PostgreSQL ROLE/DATABASE objects, so direct
// execution requires both a dedicated test URL and explicit cluster opt-in.
const describeWithPostgres =
  connectionString && clusterGlobalAllowed ? describe : describe.skip

/**
 * This disposable test uses one PostgreSQL service for both schemas and
 * tenant objects. Production still requires separate 18-main and 18-tenant
 * clusters; nothing here composes the provisioner into production.
 */
describeWithPostgres("PostgreSQL 18 temporary database provisioning", () => {
  let controlDatabase: PgPoolDatabase
  let superuserPool: Pool
  let tenantAdmin: PostgresTenantAdmin
  let capturingAdmin: CapturingTenantAdmin
  let store: PostgresTemporaryDatabaseOwnershipStore
  let provisioner: TemporaryDatabaseProvisioner
  let provisioningRole: string
  let provisioningPassword: string
  let firstPreviewId: string
  let secondPreviewId: string
  let firstBackendRuntimeId: string
  let secondBackendRuntimeId: string
  let firstResourceId: TemporaryDatabaseResourceId
  let secondResourceId: TemporaryDatabaseResourceId
  let firstMaterial: TemporaryDatabaseCredentialMaterial
  let secondMaterial: TemporaryDatabaseCredentialMaterial
  let liveApplicationClient: Client | null = null
  const physicalObjectNames: string[] = []
  const previewIds: string[] = []

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20)
    provisioningRole = `tp_prov_${suffix}`
    provisioningPassword = randomBytes(32).toString("base64url")
    firstPreviewId = createFullStackPreviewId()
    secondPreviewId = createFullStackPreviewId()
    firstBackendRuntimeId = `runtime-${randomUUID()}`
    secondBackendRuntimeId = `runtime-${randomUUID()}`
    firstResourceId = mintTemporaryDatabaseResourceId()
    secondResourceId = mintTemporaryDatabaseResourceId()
    physicalObjectNames.push(
      deriveTemporaryDatabaseObjectName(firstResourceId),
      deriveTemporaryDatabaseObjectName(secondResourceId),
    )
    previewIds.push(firstPreviewId, secondPreviewId)

    const controlConfig = readPostgresConfig({
      PEEPHOLE_DATABASE_URL: connectionString,
      PEEPHOLE_DATABASE_POOL_SIZE: "4",
    }).pool
    controlDatabase = new PgPoolDatabase(controlConfig)
    superuserPool = new Pool(controlConfig)

    await applyPostgresMigrations(controlDatabase)
    await applyPostgresMigrations(controlDatabase)

    const iterationResult = await superuserPool.query<{
      scram_iterations: string
    }>("SHOW scram_iterations")
    const verifier = createPostgresScramSha256Verifier(
      provisioningPassword,
      randomBytes(16),
      Number(iterationResult.rows[0]?.scram_iterations),
    )
    await superuserPool.query(
      `CREATE ROLE ${provisioningRole} WITH LOGIN PASSWORD '${verifier}' NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`,
    )

    await insertFullStackParent(
      controlDatabase,
      firstPreviewId,
      firstBackendRuntimeId,
    )
    await insertFullStackParent(
      controlDatabase,
      secondPreviewId,
      secondBackendRuntimeId,
    )

    const adminUrl = cleanConnectionUrl(connectionString!)
    adminUrl.username = provisioningRole
    adminUrl.password = provisioningPassword
    tenantAdmin = new PostgresTenantAdmin({
      connectionString: adminUrl.toString(),
      max: 2,
      ssl: false,
    })
    capturingAdmin = new CapturingTenantAdmin(tenantAdmin)
    store = new PostgresTemporaryDatabaseOwnershipStore(controlDatabase)
    const ids = [firstResourceId, secondResourceId]
    provisioner = new TemporaryDatabaseProvisioner({
      ownershipStore: store,
      tenantAdmin: capturingAdmin,
      createResourceId: () => {
        const next = ids.shift()
        if (!next) throw new Error("No integration resource id remains.")
        return next
      },
    })
  })

  afterAll(async () => {
    await liveApplicationClient?.end().catch(() => undefined)
    await tenantAdmin?.close().catch(() => undefined)

    if (superuserPool) {
      for (const objectName of physicalObjectNames) {
        await superuserPool
          .query(`DROP DATABASE IF EXISTS ${objectName} WITH (FORCE)`)
          .catch(() => undefined)
        await superuserPool
          .query(`DROP ROLE IF EXISTS ${objectName}`)
          .catch(() => undefined)
      }
    }

    if (controlDatabase) {
      await controlDatabase
        .query(
          "DELETE FROM peephole_temporary_databases WHERE preview_id = ANY($1::text[])",
          [previewIds],
        )
        .catch(() => undefined)
      await controlDatabase
        .query(
          "DELETE FROM peephole_fullstack_previews WHERE id = ANY($1::text[])",
          [previewIds],
        )
        .catch(() => undefined)
    }

    if (superuserPool && provisioningRole) {
      await superuserPool
        .query(`DROP ROLE IF EXISTS ${provisioningRole}`)
        .catch(() => undefined)
      await superuserPool.end()
    }
    await controlDatabase?.close().catch(() => undefined)
  })

  it("runs specifically against PostgreSQL major version 18", async () => {
    const result = await controlDatabase.query<{ version_num: string }>(
      "SELECT current_setting('server_version_num') AS version_num",
    )
    const versionNumber = Number(result.rows[0]?.version_num)
    expect(versionNumber).toBeGreaterThanOrEqual(180_000)
    expect(versionNumber).toBeLessThan(190_000)
  })

  it("applies migration 005 idempotently with a secret-free ownership shape", async () => {
    const columns = await controlDatabase.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'peephole_temporary_databases'
        ORDER BY ordinal_position
      `,
    )
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "resource_id",
      "preview_id",
      "backend_runtime_id",
      "status",
      "created_at",
      "updated_at",
    ])
  })

  it("rejects ownerless rows and enforces unique preview/runtime ownership", async () => {
    const orphanResourceId = mintTemporaryDatabaseResourceId()
    await expect(
      store.createProvisioning({
        resourceId: orphanResourceId,
        previewId: createFullStackPreviewId(),
        backendRuntimeId: `runtime-${randomUUID()}`,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "OWNER_NOT_FOUND" })

    await store.createProvisioning({
      resourceId: firstResourceId,
      previewId: firstPreviewId,
      backendRuntimeId: firstBackendRuntimeId,
      now: new Date(),
    })
    await expect(
      store.createProvisioning({
        resourceId: mintTemporaryDatabaseResourceId(),
        previewId: firstPreviewId,
        backendRuntimeId: `runtime-${randomUUID()}`,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      store.createProvisioning({
        resourceId: mintTemporaryDatabaseResourceId(),
        previewId: secondPreviewId,
        backendRuntimeId: firstBackendRuntimeId,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    // Let the real provisioner own the authoritative durable-first insert.
    await controlDatabase.query(
      "DELETE FROM peephole_temporary_databases WHERE resource_id = $1",
      [firstResourceId],
    )
  })

  it("provisions through a restricted non-superuser and proves SCRAM authentication", async () => {
    const provisionerAttributes = await superuserPool.query<RoleAttributes>(
      `${ROLE_ATTRIBUTES_SQL} WHERE rolname = $1`,
      [provisioningRole],
    )
    expect(provisionerAttributes.rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: true,
      rolcreaterole: true,
      rolreplication: false,
      rolbypassrls: false,
    })

    await expect(readProvisionerSessionPolicy(tenantAdmin)).resolves.toEqual({
      sessionUser: provisioningRole,
      currentUser: provisioningRole,
      createroleSelfGrant: "",
    })

    firstMaterial = await provisioner.provision({
      previewId: firstPreviewId,
      backendRuntimeId: firstBackendRuntimeId,
    })
    secondMaterial = await provisioner.provision({
      previewId: secondPreviewId,
      backendRuntimeId: secondBackendRuntimeId,
    })
    await expectProvisionerSessionIdentity(tenantAdmin, provisioningRole)

    const firstAttributes = await superuserPool.query<RoleAttributes>(
      `${ROLE_ATTRIBUTES_SQL} WHERE rolname = $1`,
      [firstMaterial.roleName],
    )
    expect(firstAttributes.rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 3,
    })

    const membership = await superuserPool.query<{
      admin_option: boolean
      inherit_option: boolean
      set_option: boolean
    }>(
      `
        SELECT bool_or(membership.admin_option) AS admin_option,
               bool_or(membership.inherit_option) AS inherit_option,
               bool_or(membership.set_option) AS set_option
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
        JOIN pg_roles AS member ON member.oid = membership.member
        WHERE granted.rolname = $1 AND member.rolname = $2
      `,
      [firstMaterial.roleName, provisioningRole],
    )
    expect(membership.rows[0]).toEqual({
      admin_option: true,
      inherit_option: false,
      set_option: true,
    })

    const database = await superuserPool.query<{
      datallowconn: boolean
      owner_name: string
    }>(
      `
        SELECT datallowconn, pg_get_userbyid(datdba) AS owner_name
        FROM pg_database WHERE datname = $1
      `,
      [firstMaterial.databaseName],
    )
    expect(database.rows[0]).toEqual({
      datallowconn: true,
      owner_name: firstMaterial.roleName,
    })

    const publicPrivileges = await superuserPool.query<{
      privilege_type: string
    }>(
      `
        SELECT acl.privilege_type
        FROM pg_database AS database,
             LATERAL aclexplode(
               coalesce(database.datacl, acldefault('d', database.datdba))
             ) AS acl
        WHERE database.datname = $1 AND acl.grantee = 0
      `,
      [firstMaterial.databaseName],
    )
    expect(
      publicPrivileges.rows.map((row) => row.privilege_type),
    ).not.toContain("CONNECT")
    expect(
      publicPrivileges.rows.map((row) => row.privilege_type),
    ).not.toContain("TEMPORARY")

    const storedVerifier = await superuserPool.query<{
      rolpassword: string
    }>("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [
      firstMaterial.roleName,
    ])
    const tenantIterations = await superuserPool.query<{
      scram_iterations: string
    }>("SHOW scram_iterations")
    expect(storedVerifier.rows[0]?.rolpassword).toMatch(
      new RegExp(
        `^SCRAM-SHA-256\\$${tenantIterations.rows[0]?.scram_iterations}:`,
      ),
    )

    liveApplicationClient = await connectAs(
      firstMaterial,
      firstMaterial.password.reveal(),
    )
    // DROP DATABASE ... WITH (FORCE) terminates this idle client by design;
    // consume the expected asynchronous client error and assert closure below.
    liveApplicationClient.on("error", () => undefined)
    await expect(
      liveApplicationClient.query("SELECT current_user"),
    ).resolves.toMatchObject({
      rows: [{ current_user: firstMaterial.roleName }],
    })
    await expect(
      connectAs(firstMaterial, "definitely_the_wrong_password"),
    ).rejects.toBeDefined()
    await expect(
      connectAs(
        { ...firstMaterial, password: secondMaterial.password },
        secondMaterial.password.reveal(),
        secondMaterial.roleName,
      ),
    ).rejects.toBeDefined()

    const emittedSql = capturingAdmin.queries
      .map((query) => query.text)
      .join("\n")
    assertSecretsAbsentFromSql(emittedSql, [
      firstMaterial.password.reveal(),
      secondMaterial.password.reveal(),
    ])
    expect(emittedSql).toContain("SCRAM-SHA-256$")
  })

  it("revokes with FORCE, removes role/database, preserves durable evidence, and blocks parent deletion", async () => {
    await provisioner.revoke(firstResourceId)

    await expect(liveApplicationClient!.query("SELECT 1")).rejects.toBeDefined()
    await liveApplicationClient!.end().catch(() => undefined)
    liveApplicationClient = null

    const physical = await superuserPool.query<{
      database_exists: boolean
      role_exists: boolean
    }>(
      `
        SELECT
          EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists
      `,
      [firstMaterial.databaseName],
    )
    expect(physical.rows[0]).toEqual({
      database_exists: false,
      role_exists: false,
    })
    expect((await store.getByResourceId(firstResourceId))?.status).toBe(
      "revoked",
    )

    await expect(
      controlDatabase.query(
        "DELETE FROM peephole_fullstack_previews WHERE id = $1",
        [firstPreviewId],
      ),
    ).rejects.toMatchObject({ code: "23001" })

    await provisioner.revoke(secondResourceId)
    expect((await store.getByResourceId(secondResourceId))?.status).toBe(
      "revoked",
    )
    await expectProvisionerSessionIdentity(tenantAdmin, provisioningRole)
  })

  it("integrates trusted backend lifecycle identity, runtime credential delivery, and real FORCE teardown", async () => {
    const previewId = createFullStackPreviewId()
    const backendRuntimeId = `runtime-${randomUUID()}`
    const resourceId = mintTemporaryDatabaseResourceId()
    const objectName = deriveTemporaryDatabaseObjectName(resourceId)
    previewIds.push(previewId)
    physicalObjectNames.push(objectName)
    await insertFullStackParent(controlDatabase, previewId, backendRuntimeId)

    const integratedProvisioner = new TemporaryDatabaseProvisioner({
      ownershipStore: store,
      tenantAdmin: capturingAdmin,
      createResourceId: () => resourceId,
    })
    const repository = {
      repositoryId: 1,
      owner: "peephole-integration",
      name: "temporary-database",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    }
    const plan: BackendRuntimePlan = {
      contractVersion: "backend-v1",
      repository,
      sourceRoot: "backend",
      adapterId: "express-node-npm-v1",
      packageManager: "npm",
      install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
      start: { command: "node", args: ["src/server.js"] },
      internalPort: 3000,
      platformEnvironment: {
        PORT: "3000",
        HOST: "0.0.0.0",
        NODE_ENV: "production",
      },
      generatedSecretNames: [],
      databaseRequirement: { name: "DATABASE_URL" },
    }
    const backendStore = new InMemoryBackendRuntimeStore()
    const backendQueue = new InMemoryBackendRuntimeQueue()
    const controlPlane = new BackendRuntimeControlPlane(
      { resolve: async () => plan },
      backendStore,
      backendQueue,
      { createId: () => backendRuntimeId },
    )
    const byteStore = new ArchiveByteStore()
    const roots: string[] = []
    let deliveredDatabase:
      Parameters<BackendRuntimeProcessStarter["start"]>[3] | undefined
    let resolveExit!: (value: { exitCode: number | null }) => void
    const exit = new Promise<{ exitCode: number | null }>((resolve) => {
      resolveExit = resolve
    })
    const supervisor = new BackendRuntimeSupervisor(
      controlPlane,
      {
        fetch: async () => {
          byteStore.put(repository.commitSha, new Uint8Array())
          return {
            compressedBytes: 10,
            entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
          }
        },
      },
      byteStore,
      new ExtractionState(async (_data, options) => {
        const sourceRoot = path.join(options.destinationDir, "backend")
        await mkdir(path.join(sourceRoot, "src"), { recursive: true })
        await writeFile(path.join(sourceRoot, "package-lock.json"), "{}")
        await writeFile(path.join(sourceRoot, "src", "server.js"), "")
      }),
      {
        allocate: async (id) => {
          const rootDir = await mkdtemp(
            path.join(os.tmpdir(), "peephole-c4-postgres-"),
          )
          roots.push(rootDir)
          return {
            id,
            rootDir,
            remainingMs: () => 60_000,
            destroy: async () => rm(rootDir, { recursive: true, force: true }),
          }
        },
      },
      { run: async () => undefined },
      {
        start: async (_workspace, _plan, _secrets, databaseCredential) => {
          deliveredDatabase = databaseCredential
          return {
            dialTarget: { host: "10.90.0.2", port: 3000 },
            waitUntilReady: async () => undefined,
            waitForExit: () => exit,
            stop: async () => resolveExit({ exitCode: 0 }),
          }
        },
      },
      new LiveBackendRuntimeRegistry(),
      {
        temporaryDatabaseProvisioner: integratedProvisioner,
        cancellationPollMs: 10,
        monitorPollMs: 10,
      },
    )

    await controlPlane.createForOrchestration(
      { repository, contractVersion: "backend-v1" },
      `integration-${previewId}`,
      previewId,
    )
    const leased = await backendQueue.lease("worker-1")
    expect(leased?.job.runtimeId).toBe(backendRuntimeId)
    const run = supervisor.run(leased!.job)
    await expect
      .poll(
        async () =>
          (
            await controlPlane.getForOrchestration(
              backendRuntimeId,
              `integration-${previewId}`,
            )
          ).status,
      )
      .toBe("running")

    expect(deliveredDatabase).toMatchObject({
      runtimeId: backendRuntimeId,
      resourceId,
    })
    expect(await store.getByResourceId(resourceId)).toMatchObject({
      previewId,
      backendRuntimeId,
      status: "provisioned",
    })
    const provisionedPhysical = await superuserPool.query<{
      database_exists: boolean
      role_exists: boolean
    }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
              EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists`,
      [objectName],
    )
    expect(provisionedPhysical.rows[0]).toEqual({
      database_exists: true,
      role_exists: true,
    })

    await controlPlane.cancelForOrchestration(
      backendRuntimeId,
      `integration-${previewId}`,
    )
    await run

    expect((await store.getByResourceId(resourceId))?.status).toBe("revoked")
    const revokedPhysical = await superuserPool.query<{
      database_exists: boolean
      role_exists: boolean
    }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
              EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists`,
      [objectName],
    )
    expect(revokedPhysical.rows[0]).toEqual({
      database_exists: false,
      role_exists: false,
    })
    expect(
      await controlPlane.getForOrchestration(
        backendRuntimeId,
        `integration-${previewId}`,
      ),
    ).toMatchObject({ status: "stopped", errorCode: null })
    expect(roots).toHaveLength(1)
  })
})

interface RoleAttributes extends QueryResultRow {
  rolcanlogin: boolean
  rolsuper: boolean
  rolcreatedb: boolean
  rolcreaterole: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolconnlimit: number
}

const ROLE_ATTRIBUTES_SQL = `
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolconnlimit
  FROM pg_roles
`

class CapturingTenantAdmin implements TenantDatabaseAdmin {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = []

  constructor(private readonly inner: TenantDatabaseAdmin) {}

  withSession<T>(
    operation: (session: TenantAdminSession) => Promise<T>,
  ): Promise<T> {
    return this.inner.withSession((session) =>
      operation({
        discard: () => session.discard(),
        query: async <Row extends QueryResultRow = QueryResultRow>(
          text: string,
          values: readonly unknown[] = [],
        ): Promise<SqlResult<Row>> => {
          this.queries.push({ text, values })
          return session.query<Row>(text, values)
        },
      }),
    )
  }
}

async function insertFullStackParent(
  database: PgPoolDatabase,
  previewId: string,
  backendRuntimeId: string,
): Promise<void> {
  const now = new Date()
  await database.query(
    `
      INSERT INTO peephole_fullstack_previews (
        id, requester_id, idempotency_key, request_fingerprint, repository,
        frontend_source_root, backend_source_root, status, url,
        frontend_job_id, artifact_id, backend_runtime_id, error_code,
        error_message, created_at, updated_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, 'frontend', 'backend', 'queued', NULL,
        NULL, NULL, $6, NULL, NULL, $7, $7, $8
      )
    `,
    [
      previewId,
      `integration-${previewId}`,
      `request-${previewId}`,
      `fingerprint-${previewId}`,
      JSON.stringify({
        repositoryId: 1,
        owner: "peephole-integration",
        name: "temporary-database",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
      backendRuntimeId,
      now,
      new Date(now.getTime() + 60_000),
    ],
  )
}

function cleanConnectionUrl(value: string): URL {
  const url = new URL(value)
  url.searchParams.delete("options")
  return url
}

async function connectAs(
  material: TemporaryDatabaseCredentialMaterial,
  password: string,
  roleName = material.roleName,
): Promise<Client> {
  const url = cleanConnectionUrl(connectionString!)
  url.username = roleName
  url.password = password
  url.pathname = `/${material.databaseName}`
  const client = new Client({ connectionString: url.toString(), ssl: false })
  try {
    await client.connect()
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

async function readProvisionerSessionPolicy(
  admin: TenantDatabaseAdmin,
): Promise<{
  sessionUser: string
  currentUser: string
  createroleSelfGrant: string
}> {
  return admin.withSession(async (session) => {
    const identity = await session.query<{
      session_user: string
      current_user: string
    }>("SELECT session_user AS session_user, current_user AS current_user")
    const policy = await session.query<{ createrole_self_grant: string }>(
      "SHOW createrole_self_grant",
    )
    return {
      sessionUser: identity.rows[0]!.session_user,
      currentUser: identity.rows[0]!.current_user,
      createroleSelfGrant: policy.rows[0]!.createrole_self_grant,
    }
  })
}

async function expectProvisionerSessionIdentity(
  admin: TenantDatabaseAdmin,
  expectedRole: string,
): Promise<void> {
  const policy = await readProvisionerSessionPolicy(admin)
  expect(policy.sessionUser).toBe(expectedRole)
  expect(policy.currentUser).toBe(expectedRole)
}

function assertSecretsAbsentFromSql(sql: string, secrets: string[]): void {
  if (secrets.some((secret) => sql.includes(secret))) {
    throw new Error(
      "Captured provisioning SQL contained raw credential material.",
    )
  }
}
