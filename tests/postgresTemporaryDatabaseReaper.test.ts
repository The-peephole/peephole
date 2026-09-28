import { randomBytes, randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

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
import { PostgresTemporaryDatabaseTenantCatalog } from "../services/temporary-database/postgresTenantCatalog"
import { PostgresTenantAdmin } from "../services/temporary-database/postgresTenantAdmin"
import { TemporaryDatabaseOrphanReaper } from "../services/temporary-database/temporaryDatabaseOrphanReaper"
import { PostgresTemporaryDatabasePhysicalCleaner } from "../services/temporary-database/temporaryDatabasePhysicalCleaner"
import { TemporaryDatabaseProvisioner } from "../services/temporary-database/temporaryDatabaseProvisioner"
import type { TemporaryDatabaseStatus } from "../types/temporaryDatabase"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const clusterGlobalAllowed =
  process.env.PEEPHOLE_POSTGRES_ALLOW_CLUSTER_GLOBAL === "1"
// This suite creates disposable cluster-global PostgreSQL ROLE/DATABASE
// objects and therefore uses exactly the same explicit C2A safety gate.
const describeWithPostgres =
  connectionString && clusterGlobalAllowed ? describe : describe.skip

describeWithPostgres("PostgreSQL 18 temporary database reconciliation", () => {
  let controlDatabase: PgPoolDatabase
  let superuserPool: Pool
  let tenantAdmin: PostgresTenantAdmin
  let store: PostgresTemporaryDatabaseOwnershipStore
  let catalog: PostgresTemporaryDatabaseTenantCatalog
  let cleaner: PostgresTemporaryDatabasePhysicalCleaner
  let provisioningRole: string
  let provisioningPassword: string
  const resourceIds: TemporaryDatabaseResourceId[] = []
  const previewIds: string[] = []
  const unrelatedDatabases: string[] = []
  const unrelatedRoles: string[] = []

  beforeAll(async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20)
    provisioningRole = `tr_prov_${suffix}`
    provisioningPassword = randomBytes(32).toString("base64url")
    const controlConfig = readPostgresConfig({
      PEEPHOLE_DATABASE_URL: connectionString,
      PEEPHOLE_DATABASE_POOL_SIZE: "4",
    }).pool
    controlDatabase = new PgPoolDatabase(controlConfig)
    superuserPool = new Pool(controlConfig)
    await applyPostgresMigrations(controlDatabase)

    const iterations = await superuserPool.query<{ scram_iterations: string }>(
      "SHOW scram_iterations",
    )
    const verifier = createPostgresScramSha256Verifier(
      provisioningPassword,
      randomBytes(16),
      Number(iterations.rows[0]?.scram_iterations),
    )
    await superuserPool.query(
      `CREATE ROLE ${provisioningRole} WITH LOGIN PASSWORD '${verifier}' NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`,
    )

    const adminUrl = cleanConnectionUrl(connectionString!)
    adminUrl.username = provisioningRole
    adminUrl.password = provisioningPassword
    tenantAdmin = new PostgresTenantAdmin({
      connectionString: adminUrl.toString(),
      max: 2,
      ssl: false,
    })
    store = new PostgresTemporaryDatabaseOwnershipStore(controlDatabase)
    catalog = new PostgresTemporaryDatabaseTenantCatalog(tenantAdmin)
    cleaner = new PostgresTemporaryDatabasePhysicalCleaner(tenantAdmin)
  })

  afterEach(async () => {
    await cleanupResources()
  })

  afterAll(async () => {
    await cleanupResources().catch(() => undefined)
    await tenantAdmin?.close().catch(() => undefined)
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

  it("terminalizes a durable-row-only provisioning crash", async () => {
    const owned = await createDurable("provisioning")
    await expect(reaper().reapAll()).resolves.toEqual([owned.resourceId])
    expect((await store.getByResourceId(owned.resourceId))?.status).toBe(
      "revoked",
    )
  })

  it("removes a role-only crash before the explicit SET grant", async () => {
    const owned = await createDurable("provisioning")
    await createRestrictedRole(owned.resourceId, false)

    await expect(reaper().reapAll()).resolves.toEqual([owned.resourceId])
    await expectPresence(owned.resourceId, false, false)
  })

  it("removes a role-only crash after the explicit SET grant", async () => {
    const owned = await createDurable("provisioning")
    await createRestrictedRole(owned.resourceId, true)

    await expect(reaper().reapAll()).resolves.toEqual([owned.resourceId])
    await expectPresence(owned.resourceId, false, false)
  })

  it("reaps a complete C2A resource through the shared FORCE cleaner", async () => {
    const owned = await createParent()
    const provisioner = new TemporaryDatabaseProvisioner({
      ownershipStore: store,
      tenantAdmin,
      createResourceId: () => owned.resourceId,
    })
    const material = await provisioner.provision({
      previewId: owned.previewId,
      backendRuntimeId: owned.backendRuntimeId,
    })
    const live = await connectAs(
      material.databaseName,
      material.roleName,
      material.password.reveal(),
    )
    live.on("error", () => undefined)

    await expect(reaper().reapAll()).resolves.toEqual([owned.resourceId])
    await expect(live.query("SELECT 1")).rejects.toBeDefined()
    await live.end().catch(() => undefined)
    await expectPresence(owned.resourceId, false, false)
    expect((await store.getByResourceId(owned.resourceId))?.status).toBe(
      "revoked",
    )
  })

  it("rejects an unowned valid pv_* role and leaves it intact", async () => {
    const id = trackResource(mintTemporaryDatabaseResourceId())
    await createRestrictedRole(id, false)
    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    })
    await expectPresence(id, false, true)
  })

  it("rejects an unowned valid pv_* database and leaves it intact", async () => {
    const id = trackResource(mintTemporaryDatabaseResourceId())
    const name = deriveTemporaryDatabaseObjectName(id)
    await tenantAdmin.withSession(async (session) => {
      await session.query(
        `CREATE DATABASE ${name} WITH OWNER = ${provisioningRole} TEMPLATE = template0 ENCODING = 'UTF8'`,
      )
    })
    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    })
    await expectPresence(id, true, false)
  })

  it("rejects a matching database owned by the wrong role", async () => {
    const owned = await createDurable("provisioning")
    await createRestrictedRole(owned.resourceId, true)
    const name = deriveTemporaryDatabaseObjectName(owned.resourceId)
    await tenantAdmin.withSession(async (session) => {
      await session.query(
        `CREATE DATABASE ${name} WITH OWNER = ${provisioningRole} TEMPLATE = template0 ENCODING = 'UTF8'`,
      )
    })

    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "INVARIANT_VIOLATION",
    })
    await expectPresence(owned.resourceId, true, true)
  })

  it("rejects a database whose application role has lost SET membership", async () => {
    const owned = await createDurable("provisioning")
    await createRestrictedRole(owned.resourceId, true)
    const name = deriveTemporaryDatabaseObjectName(owned.resourceId)
    await tenantAdmin.withSession(async (session) => {
      await session.query(
        `CREATE DATABASE ${name} WITH OWNER = ${name} TEMPLATE = template0 ENCODING = 'UTF8'`,
      )
      await session.query(
        `GRANT ${name} TO ${provisioningRole} WITH SET FALSE, INHERIT FALSE`,
      )
    })

    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "INVARIANT_VIOLATION",
    })
    await expectPresence(owned.resourceId, true, true)
  })

  it("rejects physical residue for a revoked durable row", async () => {
    const owned = await createDurable("revoked")
    await createRestrictedRole(owned.resourceId, false)
    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "INVARIANT_VIOLATION",
    })
    await expectPresence(owned.resourceId, false, true)
  })

  it("audits all resources before deleting an otherwise safe owned role", async () => {
    const owned = await createDurable("provisioning")
    await createRestrictedRole(owned.resourceId, false)
    const unownedId = trackResource(mintTemporaryDatabaseResourceId())
    await createRestrictedRole(unownedId, false)

    await expect(reaper().reapAll()).rejects.toMatchObject({
      code: "AUDIT_FAILED",
    })
    await expectPresence(owned.resourceId, false, true)
    expect((await store.getByResourceId(owned.resourceId))?.status).toBe(
      "provisioning",
    )
  })

  it("ignores unrelated non-pv database and role resources", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16)
    const unrelatedRole = `other_role_${suffix}`
    const unrelatedDatabase = `other_db_${suffix}`
    unrelatedRoles.push(unrelatedRole)
    unrelatedDatabases.push(unrelatedDatabase)
    await superuserPool.query(`CREATE ROLE ${unrelatedRole}`)
    await superuserPool.query(
      `CREATE DATABASE ${unrelatedDatabase} OWNER ${unrelatedRole}`,
    )
    const owned = await createDurable("provisioning")

    await expect(reaper().reapAll()).resolves.toEqual([owned.resourceId])
    const remains = await superuserPool.query<{
      database_exists: boolean
      role_exists: boolean
    }>(
      `
        SELECT
          EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
      `,
      [unrelatedDatabase, unrelatedRole],
    )
    expect(remains.rows[0]).toEqual({
      database_exists: true,
      role_exists: true,
    })
  })

  function reaper(): TemporaryDatabaseOrphanReaper {
    return new TemporaryDatabaseOrphanReaper({
      ownershipStore: store,
      tenantCatalog: catalog,
      physicalCleaner: cleaner,
      now: () => new Date(),
    })
  }

  async function createParent(): Promise<{
    resourceId: TemporaryDatabaseResourceId
    previewId: string
    backendRuntimeId: string
  }> {
    const resourceId = trackResource(mintTemporaryDatabaseResourceId())
    const previewId = createFullStackPreviewId()
    const backendRuntimeId = `runtime-${randomUUID()}`
    previewIds.push(previewId)
    await insertFullStackParent(controlDatabase, previewId, backendRuntimeId)
    return { resourceId, previewId, backendRuntimeId }
  }

  async function createDurable(status: TemporaryDatabaseStatus) {
    const owned = await createParent()
    const timestamp = new Date(Date.now() - 60 * 60_000)
    await store.createProvisioning({ ...owned, now: timestamp })
    if (status !== "provisioning") {
      await store.markProvisioned(owned.resourceId, timestamp)
    }
    if (["revoking", "revoked", "revoke_failed"].includes(status)) {
      await store.markRevoking(owned.resourceId, timestamp)
    }
    if (status === "revoked") {
      await store.markRevoked(owned.resourceId, timestamp)
    } else if (status === "revoke_failed") {
      await store.markRevokeFailed(owned.resourceId, timestamp)
    }
    return owned
  }

  async function createRestrictedRole(
    id: TemporaryDatabaseResourceId,
    grantSet: boolean,
  ): Promise<void> {
    const name = deriveTemporaryDatabaseObjectName(id)
    await tenantAdmin.withSession(async (session) => {
      await session.query(
        `CREATE ROLE ${name} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3`,
      )
      if (grantSet) {
        await session.query(
          `GRANT ${name} TO ${provisioningRole} WITH SET TRUE, INHERIT FALSE`,
        )
      }
    })
  }

  function trackResource(
    id: TemporaryDatabaseResourceId,
  ): TemporaryDatabaseResourceId {
    resourceIds.push(id)
    return id
  }

  async function expectPresence(
    id: TemporaryDatabaseResourceId,
    database: boolean,
    role: boolean,
  ): Promise<void> {
    await expect(catalog.inspectResource(id)).resolves.toEqual({
      database,
      role,
    })
  }

  async function cleanupResources(): Promise<void> {
    for (const id of resourceIds.splice(0)) {
      const name = deriveTemporaryDatabaseObjectName(id)
      await superuserPool
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined)
      await superuserPool
        .query(`DROP ROLE IF EXISTS ${name}`)
        .catch(() => undefined)
    }
    for (const name of unrelatedDatabases.splice(0)) {
      await superuserPool
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined)
    }
    for (const name of unrelatedRoles.splice(0)) {
      await superuserPool
        .query(`DROP ROLE IF EXISTS ${name}`)
        .catch(() => undefined)
    }
    if (previewIds.length > 0) {
      const current = previewIds.splice(0)
      await controlDatabase.query(
        "DELETE FROM peephole_temporary_databases WHERE preview_id = ANY($1::text[])",
        [current],
      )
      await controlDatabase.query(
        "DELETE FROM peephole_fullstack_previews WHERE id = ANY($1::text[])",
        [current],
      )
    }
  }

  async function connectAs(
    databaseName: string,
    roleName: string,
    password: string,
  ) {
    const url = cleanConnectionUrl(connectionString!)
    url.username = roleName
    url.password = password
    url.pathname = `/${databaseName}`
    const { Client } = await import("pg")
    const client = new Client({ connectionString: url.toString(), ssl: false })
    await client.connect()
    return client
  }
})

async function insertFullStackParent(
  database: PgPoolDatabase,
  previewId: string,
  backendRuntimeId: string,
): Promise<void> {
  const createdAt = new Date()
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
        name: "temporary-database-reaper",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
      backendRuntimeId,
      createdAt,
      new Date(createdAt.getTime() + 60_000),
    ],
  )
}

function cleanConnectionUrl(value: string): URL {
  const url = new URL(value)
  url.searchParams.delete("options")
  return url
}
