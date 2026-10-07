import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../../core/backendDatabase/databaseUrl"
import type { TemporaryDatabaseLifecycleProvisioner } from "../backend-runtime-worker/backendRuntimeSupervisor"
import type { PostgresDatabase } from "../preview-api/postgres/database"
import {
  TmpfsDatabaseCredentialFilesystem,
  type DatabaseCredentialFilesystem,
  type TmpfsDatabaseCredentialFilesystemOptions,
} from "../preview-worker/gvisor/databaseCredentialFilesystem"
import {
  DatabaseCredentialOrphanReaper,
  type DatabaseCredentialOrphanReaperOptions,
} from "../preview-worker/gvisor/databaseCredentialOrphanReaper"
import { PostgresTemporaryDatabaseOwnershipStore } from "../temporary-database/postgresOwnershipStore"
import { PostgresTenantAdmin } from "../temporary-database/postgresTenantAdmin"
import { PostgresTemporaryDatabaseTenantCatalog } from "../temporary-database/postgresTenantCatalog"
import type {
  TemporaryDatabaseOwnershipStore,
  TenantDatabaseAdmin,
} from "../temporary-database/ports"
import type { TemporaryDatabaseStatus } from "../../types/temporaryDatabase"
import {
  TemporaryDatabaseOrphanReaper,
  type TemporaryDatabaseOrphanReaperOptions,
} from "../temporary-database/temporaryDatabaseOrphanReaper"
import { PostgresTemporaryDatabasePhysicalCleaner } from "../temporary-database/temporaryDatabasePhysicalCleaner"
import { TemporaryDatabaseProvisioner } from "../temporary-database/temporaryDatabaseProvisioner"
import { readProvisioningSessionPolicy } from "../temporary-database/tenantSessionPolicy"
import type { TemporaryDatabaseProductionConfig } from "./config"
import { ensureDatabaseCredentialCapability } from "./preflight"

/** Small enough for one backend worker plus maintenance reconciliation. */
const TENANT_ADMIN_POOL_SIZE = 4

export interface ProductionTemporaryDatabaseOrphanReaper {
  reap(): Promise<unknown>
  reapAll(): Promise<unknown>
}

/** Exactly what `server.ts` needs. The provisioning credential stays inside
 * the tenant admin pool and is never exposed on this object. */
export interface ProductionTemporaryDatabaseRuntime {
  provisioner: TemporaryDatabaseLifecycleProvisioner
  credentialFilesystem: DatabaseCredentialFilesystem
  orphanReaper: ProductionTemporaryDatabaseOrphanReaper
  credentialOrphanReaper: ProductionTemporaryDatabaseOrphanReaper
  close(): Promise<void>
}

export interface ProductionTemporaryDatabaseRuntimeOptions {
  config: TemporaryDatabaseProductionConfig
  /** The already-migrated control-plane database holding ownership rows. */
  controlDatabase: PostgresDatabase
  bundlesRootDir: string
  artifactStorageDir: string
  generatedSecretRootDir: string
  orphanReaperMaxAgeMs: number
}

interface ClosableTenantAdmin extends TenantDatabaseAdmin {
  close(): Promise<void>
}

interface ProductionTemporaryDatabaseRuntimeDependencies {
  createOwnershipStore?: (
    controlDatabase: PostgresDatabase,
  ) => TemporaryDatabaseOwnershipStore
  ensureCredentialCapability?: (options: {
    credentialRootDir: string
  }) => Promise<void>
  createTenantAdmin?: (connectionString: string) => ClosableTenantAdmin
  assertTenantCapability?: (tenantAdmin: TenantDatabaseAdmin) => Promise<void>
  createCredentialFilesystem?: (
    options: TmpfsDatabaseCredentialFilesystemOptions,
  ) => DatabaseCredentialFilesystem
  createOrphanReaper?: (
    options: TemporaryDatabaseOrphanReaperOptions,
  ) => ProductionTemporaryDatabaseOrphanReaper
  createCredentialOrphanReaper?: (
    options: DatabaseCredentialOrphanReaperOptions,
  ) => ProductionTemporaryDatabaseOrphanReaper
}

export class TenantDatabaseCapabilityError extends Error {
  constructor(reason: string) {
    super(`Tenant PostgreSQL provisioning capability check failed: ${reason}`)
    this.name = "TenantDatabaseCapabilityError"
  }
}

export class TemporaryDatabasesDisabledWithOwnedResourcesError extends Error {
  constructor(outstanding: ReadonlyMap<TemporaryDatabaseStatus, number>) {
    const summary = [...outstanding]
      .map(([status, count]) => `${status}=${String(count)}`)
      .join(", ")
    super(
      `Temporary databases are disabled, but durable temporary-database ownership still requires reconciliation (${summary}). Set PEEPHOLE_TEMPORARY_DATABASES=1 with the tenant cluster available so startup reconciliation can resolve it before FullStack previews are reconciled.`,
    )
    this.name = "TemporaryDatabasesDisabledWithOwnedResourcesError"
  }
}

/**
 * M11 production activation seam (docs/TEMPORARY_DATABASES.md section 16).
 * While disabled it reads only the control-plane ownership rows: with none,
 * or only `revoked` ones, it returns null without touching the tenant cluster
 * or the credential root. Any non-terminal row means databases this or an
 * earlier process owned may still physically exist, so startup is refused --
 * never silently skipped -- rather than letting FullStack reconciliation
 * terminalize their parents unreconciled (e.g. a rollback that switched the
 * flag off after a crash). Nothing is mutated in that case.
 *
 * When enabled, proves the credential root and the tenant provisioning
 * identity (including a Unix-domain-socket session), then runs startup reconciliation for both
 * temporary databases and their credential files before returning -- the
 * caller must do this before `FullStackPreviewStartupReconciler` and before
 * any listener or worker exists. Any failure rejects; it never degrades to
 * running without database support.
 */
export async function initializeProductionTemporaryDatabaseRuntime(
  options: ProductionTemporaryDatabaseRuntimeOptions,
  dependencies: ProductionTemporaryDatabaseRuntimeDependencies = {},
): Promise<ProductionTemporaryDatabaseRuntime | null> {
  const { config } = options
  const ownershipStore = (
    dependencies.createOwnershipStore ??
    ((controlDatabase) =>
      new PostgresTemporaryDatabaseOwnershipStore(controlDatabase))
  )(options.controlDatabase)

  if (!config.enabled) {
    const outstanding = new Map<TemporaryDatabaseStatus, number>()
    for (const record of await ownershipStore.listAll()) {
      if (record.status === "revoked") continue
      outstanding.set(record.status, (outstanding.get(record.status) ?? 0) + 1)
    }
    if (outstanding.size > 0) {
      throw new TemporaryDatabasesDisabledWithOwnedResourcesError(outstanding)
    }
    return null
  }

  const credentialFilesystem = (
    dependencies.createCredentialFilesystem ??
    ((filesystemOptions) =>
      new TmpfsDatabaseCredentialFilesystem(filesystemOptions))
  )({
    rootDir: config.credentialRootDir,
    forbiddenRoots: [
      options.bundlesRootDir,
      options.artifactStorageDir,
      options.generatedSecretRootDir,
    ],
  })
  await (
    dependencies.ensureCredentialCapability ??
    ensureDatabaseCredentialCapability
  )({
    credentialRootDir: config.credentialRootDir,
  })

  const tenantAdmin = (
    dependencies.createTenantAdmin ??
    ((connectionString) =>
      new PostgresTenantAdmin({
        connectionString,
        max: TENANT_ADMIN_POOL_SIZE,
      }))
  )(config.provisioningUrl)

  try {
    await (
      dependencies.assertTenantCapability ?? assertTenantProvisioningCapability
    )(tenantAdmin)

    const physicalCleaner = new PostgresTemporaryDatabasePhysicalCleaner(
      tenantAdmin,
    )
    const provisioner = new TemporaryDatabaseProvisioner({
      ownershipStore,
      tenantAdmin,
      physicalCleaner,
    })
    const orphanReaper = (
      dependencies.createOrphanReaper ??
      ((reaperOptions) => new TemporaryDatabaseOrphanReaper(reaperOptions))
    )({
      ownershipStore,
      tenantCatalog: new PostgresTemporaryDatabaseTenantCatalog(tenantAdmin),
      physicalCleaner,
      maxAgeMs: options.orphanReaperMaxAgeMs,
    })
    const credentialOrphanReaper = (
      dependencies.createCredentialOrphanReaper ??
      ((reaperOptions) => new DatabaseCredentialOrphanReaper(reaperOptions))
    )({
      rootDir: config.credentialRootDir,
      filesystem: credentialFilesystem,
      maxAgeMs: options.orphanReaperMaxAgeMs,
    })

    // Startup reconciliation: no durable FullStack parent may be terminalized
    // and no new runtime may provision until every non-terminal ownership row
    // and every leftover credential file from an earlier process is resolved.
    await orphanReaper.reapAll()
    await credentialOrphanReaper.reapAll()

    return {
      provisioner,
      credentialFilesystem,
      orphanReaper,
      credentialOrphanReaper,
      close: () => tenantAdmin.close(),
    }
  } catch (error) {
    await tenantAdmin.close().catch(() => undefined)
    throw error
  }
}

/** The backend composition's paired M11 dependencies: both or neither. */
export function temporaryDatabaseBackendDependencies(
  runtime: ProductionTemporaryDatabaseRuntime | null,
): {
  temporaryDatabaseProvisioner?: TemporaryDatabaseLifecycleProvisioner
  databaseCredentialFilesystem?: DatabaseCredentialFilesystem
} {
  if (!runtime) return {}
  return {
    temporaryDatabaseProvisioner: runtime.provisioner,
    databaseCredentialFilesystem: runtime.credentialFilesystem,
  }
}

/** Periodic maintenance work; empty while temporary databases are disabled. */
export function temporaryDatabaseMaintenanceTasks(
  runtime: ProductionTemporaryDatabaseRuntime | null,
): Array<Promise<unknown>> {
  if (!runtime) return []
  return [runtime.orphanReaper.reap(), runtime.credentialOrphanReaper.reap()]
}

/**
 * Proves the configured provisioning identity is the locked tenant endpoint
 * and role policy (docs/TEMPORARY_DATABASES.md sections 6, 8, 9) before any
 * reconciliation or provisioning uses it. Errors carry only a fixed reason
 * and, at most, a SQLSTATE -- never the connection string, role password, or
 * driver message text.
 */
export async function assertTenantProvisioningCapability(
  tenantAdmin: TenantDatabaseAdmin,
): Promise<void> {
  let facts: TenantCapabilityRow | undefined
  try {
    facts = await tenantAdmin.withSession(async (session) => {
      await readProvisioningSessionPolicy(session)
      const result = await session.query<TenantCapabilityRow>(
        `SELECT current_setting('server_version_num')::int AS version,
                current_setting('port') AS port,
                current_setting('listen_addresses') AS listen_addresses,
                inet_server_addr() IS NULL AS unix_socket,
                r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
                r.rolreplication, r.rolbypassrls
           FROM pg_roles r
          WHERE r.rolname = current_user`,
      )
      return result.rows[0]
    })
  } catch (error) {
    throw new TenantDatabaseCapabilityError(unavailableReason(error))
  }

  if (!facts) {
    throw new TenantDatabaseCapabilityError("provisioning role not found")
  }
  // PostgreSQL documents inet_server_addr() as NULL exactly when the current
  // connection is a Unix-domain socket; provisioning must never ride TCP,
  // least of all the sandbox-facing listener.
  if (facts.unix_socket !== true) {
    throw new TenantDatabaseCapabilityError(
      "the provisioning session must use the local Unix-domain socket, not TCP",
    )
  }
  if (facts.version < 180_000 || facts.version >= 190_000) {
    throw new TenantDatabaseCapabilityError("PostgreSQL 18 is required")
  }
  if (
    facts.port !== String(TENANT_DATABASE_PORT) ||
    facts.listen_addresses !== TENANT_DATABASE_HOST
  ) {
    throw new TenantDatabaseCapabilityError(
      `the tenant cluster must listen only on ${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}`,
    )
  }
  if (
    !facts.rolcanlogin ||
    facts.rolsuper ||
    !facts.rolcreatedb ||
    !facts.rolcreaterole ||
    facts.rolreplication ||
    facts.rolbypassrls
  ) {
    throw new TenantDatabaseCapabilityError(
      "the provisioning role must be LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS",
    )
  }
}

interface TenantCapabilityRow {
  version: number
  port: string
  listen_addresses: string
  unix_socket: boolean
  rolcanlogin: boolean
  rolsuper: boolean
  rolcreatedb: boolean
  rolcreaterole: boolean
  rolreplication: boolean
  rolbypassrls: boolean
}

function unavailableReason(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : undefined
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? `tenant session or policy check failed (SQLSTATE ${code})`
    : "tenant session or policy check failed"
}
