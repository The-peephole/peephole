import type { TemporaryDatabaseResourceId } from "../../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../../types/temporaryDatabase"
import type {
  CreateTemporaryDatabaseOwnership,
  TemporaryDatabaseOwnershipStore,
  TemporaryDatabaseReconciliationSourceStatus,
} from "../../services/temporary-database/ports"

export class TestOwnershipStore implements TemporaryDatabaseOwnershipStore {
  private record: TemporaryDatabaseRecord | null = null
  constructor(
    private readonly onChange?: (
      record: TemporaryDatabaseRecord,
    ) => Promise<void>,
  ) {}

  async createProvisioning(
    input: CreateTemporaryDatabaseOwnership,
  ): Promise<TemporaryDatabaseRecord> {
    if (this.record) throw new Error("Test ownership already exists.")
    this.record = {
      resourceId: input.resourceId,
      previewId: input.previewId,
      backendRuntimeId: input.backendRuntimeId,
      status: "provisioning",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    }
    await this.onChange?.(this.record)
    return this.record
  }

  async getByResourceId(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.resourceId === resourceId ? this.record : null
  }

  async getByPreviewId(
    previewId: string,
  ): Promise<TemporaryDatabaseRecord | null> {
    return this.record?.previewId === previewId ? this.record : null
  }

  async listAll(): Promise<TemporaryDatabaseRecord[]> {
    return this.record ? [this.record] : []
  }

  markProvisioned(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "provisioning", "provisioned", now)
  }

  markRevoking(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "provisioned", "revoking", now)
  }

  markRevoked(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "revoking", "revoked", now)
  }

  markRevokeFailed(resourceId: TemporaryDatabaseResourceId, now: Date) {
    return this.transition(resourceId, "revoking", "revoke_failed", now)
  }

  beginReconciliation(
    resourceId: TemporaryDatabaseResourceId,
    expectedStatus: TemporaryDatabaseReconciliationSourceStatus,
    now: Date,
  ) {
    return this.transition(resourceId, expectedStatus, "revoking", now)
  }

  private async transition(
    resourceId: TemporaryDatabaseResourceId,
    from: TemporaryDatabaseStatus,
    to: TemporaryDatabaseStatus,
    now: Date,
  ): Promise<TemporaryDatabaseRecord> {
    if (!this.record || this.record.resourceId !== resourceId) {
      throw new Error("Test ownership does not exist.")
    }
    if (this.record.status !== from) {
      throw new Error("Test ownership transition was rejected.")
    }
    this.record = { ...this.record, status: to, updatedAt: now.toISOString() }
    await this.onChange?.(this.record)
    return this.record
  }
}
