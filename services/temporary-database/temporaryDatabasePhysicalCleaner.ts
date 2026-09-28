import {
  deriveTemporaryDatabaseObjectName,
  validateTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabasePhysicalCleaner,
  TenantDatabaseAdmin,
} from "./ports"
import {
  readProvisioningSessionPolicy,
  withTemporaryDatabaseRole,
} from "./tenantSessionPolicy"

export class TemporaryDatabasePhysicalCleanupError extends Error {
  constructor(readonly databaseRemoved: boolean) {
    super("Temporary database physical cleanup failed.")
    this.name = "TemporaryDatabasePhysicalCleanupError"
  }
}

/** Shared, narrow C2A/C2B physical deletion path. */
export class PostgresTemporaryDatabasePhysicalCleaner implements TemporaryDatabasePhysicalCleaner {
  constructor(private readonly tenantAdmin: TenantDatabaseAdmin) {}

  async cleanupFull(resourceId: TemporaryDatabaseResourceId): Promise<void> {
    const objectName = deriveTemporaryDatabaseObjectName(
      validateTemporaryDatabaseResourceId(resourceId),
    )
    let databaseRemoved = false
    try {
      await this.tenantAdmin.withSession(async (session) => {
        const provisioningRole = await readProvisioningSessionPolicy(session)
        await withTemporaryDatabaseRole(
          session,
          objectName,
          provisioningRole,
          async () => {
            await session.query(`DROP DATABASE ${objectName} WITH (FORCE)`)
            databaseRemoved = true
          },
        )
        await session.query(`DROP ROLE ${objectName}`)
      })
    } catch {
      throw new TemporaryDatabasePhysicalCleanupError(databaseRemoved)
    }
  }

  async cleanupRoleOnly(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<void> {
    const objectName = deriveTemporaryDatabaseObjectName(
      validateTemporaryDatabaseResourceId(resourceId),
    )
    try {
      await this.tenantAdmin.withSession(async (session) => {
        await readProvisioningSessionPolicy(session)
        await session.query(`DROP ROLE ${objectName}`)
      })
    } catch {
      // The database is already proven absent for this bounded path.
      throw new TemporaryDatabasePhysicalCleanupError(true)
    }
  }
}
