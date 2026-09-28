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

/**
 * Process-memory-only, internal-only runtime material for the low-level
 * gVisor process starter (M11-C3). Assembled from
 * `TemporaryDatabaseCredentialMaterial` by `buildTemporaryDatabaseUrl()`
 * (`core/backendDatabase/databaseUrl.ts`) plus the target runtime's own id.
 * Must never become part of `BackendRuntimePlan`, `QueuedBackendRuntime`,
 * public `BackendRuntime`, an HTTP request/response, durable PostgreSQL
 * state, an idempotency fingerprint, or a log line -- see
 * docs/TEMPORARY_DATABASES.md section 15.
 */
export interface TemporaryDatabaseRuntimeCredentialMaterial {
  readonly runtimeId: string
  readonly resourceId: TemporaryDatabaseResourceId
  readonly databaseUrl: OpaqueSecretValue
}
