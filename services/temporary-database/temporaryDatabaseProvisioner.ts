import { randomBytes } from "node:crypto"

import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
  validateTemporaryDatabaseResourceId,
  type ResourceEntropySource,
  type TemporaryDatabaseResourceId,
} from "../../core/backendDatabase/resourceIdentity"
import {
  createPostgresScramSha256Verifier,
  validatePostgresScramSha256Verifier,
} from "../../core/backendDatabase/scramVerifier"
import { generatePreviewSecretValue } from "../../core/backendSecrets/generatedSecretValue"
import type { OpaqueSecretValue } from "../../types/backendRuntimeSecrets"
import type { TemporaryDatabaseCredentialMaterial } from "../../types/temporaryDatabase"
import type {
  TemporaryDatabaseOwnershipStore,
  TenantAdminSession,
  TenantDatabaseAdmin,
} from "./ports"

const SCRAM_SALT_BYTES = 16
const SAFE_POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

export class TemporaryDatabaseProvisioningError extends Error {
  constructor() {
    super("Temporary database provisioning failed.")
    this.name = "TemporaryDatabaseProvisioningError"
  }
}

export class TemporaryDatabaseRevocationError extends Error {
  constructor() {
    super("Temporary database revocation failed.")
    this.name = "TemporaryDatabaseRevocationError"
  }
}

export interface TemporaryDatabaseProvisionerDependencies {
  readonly ownershipStore: TemporaryDatabaseOwnershipStore
  readonly tenantAdmin: TenantDatabaseAdmin
  readonly createResourceId?: () => TemporaryDatabaseResourceId
  readonly generatePassword?: () => OpaqueSecretValue
  readonly saltEntropy?: ResourceEntropySource
  readonly now?: () => Date
}

export interface ProvisionTemporaryDatabaseInput {
  readonly previewId: string
  readonly backendRuntimeId: string
}

/**
 * Real C2A PostgreSQL primitives, deliberately not composed into any runtime
 * worker yet. Durable ownership is written before the first tenant-side
 * resource; all returned credential material remains process-local.
 */
export class TemporaryDatabaseProvisioner {
  private readonly createResourceId: () => TemporaryDatabaseResourceId
  private readonly generatePassword: () => OpaqueSecretValue
  private readonly saltEntropy: ResourceEntropySource
  private readonly now: () => Date

  constructor(
    private readonly dependencies: TemporaryDatabaseProvisionerDependencies,
  ) {
    this.createResourceId =
      dependencies.createResourceId ?? mintTemporaryDatabaseResourceId
    this.generatePassword =
      dependencies.generatePassword ?? generatePreviewSecretValue
    this.saltEntropy = dependencies.saltEntropy ?? randomBytes
    this.now = dependencies.now ?? (() => new Date())
  }

  async provision(
    input: ProvisionTemporaryDatabaseInput,
  ): Promise<TemporaryDatabaseCredentialMaterial> {
    const resourceId = this.createResourceId()
    const objectName = deriveTemporaryDatabaseObjectName(resourceId)

    try {
      await this.dependencies.ownershipStore.createProvisioning({
        resourceId,
        previewId: input.previewId,
        backendRuntimeId: input.backendRuntimeId,
        now: this.now(),
      })

      const password = this.generatePassword()
      await this.dependencies.tenantAdmin.withSession(async (session) => {
        const iterations = await readScramIterations(session)
        const salt = this.saltEntropy(SCRAM_SALT_BYTES)
        if (!(salt instanceof Uint8Array) || salt.length !== SCRAM_SALT_BYTES) {
          throw new Error("Temporary database salt entropy is invalid.")
        }
        const verifier = createPostgresScramSha256Verifier(
          password.reveal(),
          salt,
          iterations,
        )

        await session.query(createRoleSql(objectName, verifier))
        const provisioningRole = await readProvisioningRole(session)
        await session.query(
          `GRANT ${objectName} TO ${provisioningRole} WITH SET TRUE, INHERIT FALSE`,
        )
        await session.query(
          `CREATE DATABASE ${objectName} WITH OWNER = ${objectName} TEMPLATE = template0 ENCODING = 'UTF8' ALLOW_CONNECTIONS = false`,
        )
        await withRole(session, objectName, async () => {
          await session.query(
            `REVOKE CONNECT, TEMPORARY ON DATABASE ${objectName} FROM PUBLIC`,
          )
          await session.query(
            `ALTER DATABASE ${objectName} ALLOW_CONNECTIONS true`,
          )
        })
      })

      await this.dependencies.ownershipStore.markProvisioned(
        resourceId,
        this.now(),
      )
      return Object.freeze({
        resourceId,
        databaseName: objectName,
        roleName: objectName,
        password,
      })
    } catch {
      throw new TemporaryDatabaseProvisioningError()
    }
  }

  async revoke(resourceId: TemporaryDatabaseResourceId): Promise<void> {
    const validatedResourceId = validateTemporaryDatabaseResourceId(resourceId)
    const objectName = deriveTemporaryDatabaseObjectName(validatedResourceId)
    let dropRoleAttempted = false

    try {
      await this.dependencies.ownershipStore.markRevoking(
        validatedResourceId,
        this.now(),
      )
      await this.dependencies.tenantAdmin.withSession(async (session) => {
        await withRole(session, objectName, async () => {
          await session.query(`DROP DATABASE ${objectName} WITH (FORCE)`)
        })
        dropRoleAttempted = true
        await session.query(`DROP ROLE ${objectName}`)
      })
      await this.dependencies.ownershipStore.markRevoked(
        validatedResourceId,
        this.now(),
      )
    } catch {
      if (dropRoleAttempted) {
        await this.dependencies.ownershipStore
          .markRevokeFailed(validatedResourceId, this.now())
          .catch(() => undefined)
      }
      throw new TemporaryDatabaseRevocationError()
    }
  }
}

function createRoleSql(roleName: string, verifier: string): string {
  assertSafePostgresIdentifier(roleName)
  validatePostgresScramSha256Verifier(verifier)
  return (
    `CREATE ROLE ${roleName} WITH LOGIN PASSWORD '${verifier}' ` +
    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS " +
    "CONNECTION LIMIT 3"
  )
}

async function readScramIterations(
  session: TenantAdminSession,
): Promise<number> {
  const result = await session.query<{ scram_iterations: string }>(
    "SHOW scram_iterations",
  )
  const iterations = Number(result.rows[0]?.scram_iterations)
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("Tenant SCRAM iteration policy is invalid.")
  }
  return iterations
}

async function readProvisioningRole(
  session: TenantAdminSession,
): Promise<string> {
  const result = await session.query<{ provisioning_role: string }>(
    "SELECT current_user AS provisioning_role",
  )
  const role = result.rows[0]?.provisioning_role
  assertSafePostgresIdentifier(role)
  return role
}

async function withRole<T>(
  session: TenantAdminSession,
  roleName: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertSafePostgresIdentifier(roleName)
  await session.query(`SET ROLE ${roleName}`)
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  try {
    await session.query("RESET ROLE")
  } catch {
    session.discard()
    throw new Error("Tenant administrative session could not reset role.")
  }

  if (!outcome.ok) throw outcome.error
  return outcome.value
}

function assertSafePostgresIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_POSTGRES_IDENTIFIER.test(value)) {
    throw new Error("PostgreSQL administrative identifier is unsafe.")
  }
}
