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
  TemporaryDatabasePhysicalCleaner,
  TemporaryDatabaseOwnershipStore,
  TenantAdminSession,
  TenantDatabaseAdmin,
} from "./ports"
import {
  assertSafePostgresIdentifier,
  readProvisioningSessionPolicy,
  withTemporaryDatabaseRole,
} from "./tenantSessionPolicy"
import {
  PostgresTemporaryDatabasePhysicalCleaner,
  TemporaryDatabasePhysicalCleanupError,
} from "./temporaryDatabasePhysicalCleaner"

const SCRAM_SALT_BYTES = 16

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
  readonly physicalCleaner?: TemporaryDatabasePhysicalCleaner
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
  private readonly physicalCleaner: TemporaryDatabasePhysicalCleaner

  constructor(
    private readonly dependencies: TemporaryDatabaseProvisionerDependencies,
  ) {
    this.createResourceId =
      dependencies.createResourceId ?? mintTemporaryDatabaseResourceId
    this.generatePassword =
      dependencies.generatePassword ?? generatePreviewSecretValue
    this.saltEntropy = dependencies.saltEntropy ?? randomBytes
    this.now = dependencies.now ?? (() => new Date())
    this.physicalCleaner =
      dependencies.physicalCleaner ??
      new PostgresTemporaryDatabasePhysicalCleaner(dependencies.tenantAdmin)
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
        const provisioningRole = await readProvisioningSessionPolicy(session)
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
        await session.query(
          `GRANT ${objectName} TO ${provisioningRole} WITH SET TRUE, INHERIT FALSE`,
        )
        await session.query(
          `CREATE DATABASE ${objectName} WITH OWNER = ${objectName} TEMPLATE = template0 ENCODING = 'UTF8' ALLOW_CONNECTIONS = false`,
        )
        await withTemporaryDatabaseRole(
          session,
          objectName,
          provisioningRole,
          async () => {
            await session.query(
              `REVOKE CONNECT, TEMPORARY ON DATABASE ${objectName} FROM PUBLIC`,
            )
            await session.query(
              `ALTER DATABASE ${objectName} ALLOW_CONNECTIONS true`,
            )
          },
        )
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
    try {
      await this.dependencies.ownershipStore.markRevoking(
        validatedResourceId,
        this.now(),
      )
      await this.physicalCleaner.cleanupFull(validatedResourceId)
      await this.dependencies.ownershipStore.markRevoked(
        validatedResourceId,
        this.now(),
      )
    } catch (error) {
      if (
        error instanceof TemporaryDatabasePhysicalCleanupError &&
        error.databaseRemoved
      ) {
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
