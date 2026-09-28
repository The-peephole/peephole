import type { TemporaryDatabaseResourceId } from "../core/backendDatabase/resourceIdentity"
import type { OpaqueSecretValue } from "./backendRuntimeSecrets"

export type TemporaryDatabaseStatus =
  "provisioning" | "provisioned" | "revoking" | "revoked" | "revoke_failed"

/** Durable, credential-free ownership evidence stored in 18-main. */
export interface TemporaryDatabaseRecord {
  readonly resourceId: TemporaryDatabaseResourceId
  readonly previewId: string
  readonly backendRuntimeId: string
  readonly status: TemporaryDatabaseStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/** Process-memory-only output. C2A deliberately does not assemble a URL. */
export interface TemporaryDatabaseCredentialMaterial {
  readonly resourceId: TemporaryDatabaseResourceId
  readonly databaseName: string
  readonly roleName: string
  readonly password: OpaqueSecretValue
}
