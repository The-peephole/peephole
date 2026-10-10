import type { OpaqueSecretValue } from "./backendRuntimeSecrets"

/**
 * M12 user-provided preview configuration -- see
 * docs/USER_PROVIDED_ENVIRONMENT.md and D-035.
 *
 * Scope is deliberately narrow: *non-sensitive* server configuration whose
 * NAME the repository declares in a bounded `.env.example`-family template
 * at the exact commit, for a trusted `fullstack-v1` backend only. Values are
 * treated as public configuration, not secrets: the untrusted repository
 * code receives them and may echo them through its public preview URL.
 * Secret-like names, external-service credentials, database URLs,
 * client-public (`VITE_`/`NEXT_PUBLIC_`) names, and process-control names
 * are never eligible (`core/userEnvironment/userEnvironmentPolicy.ts`).
 */

/** Hard bounds shared by the extension, the HTTP parser, the server-side
 * policy, the tmpfs writer, and the trusted bootstrap. */
export const USER_ENVIRONMENT_LIMITS = Object.freeze({
  /** Maximum declared user-configurable names per backend. A commit that
   * declares more is unsupported rather than partially configured. */
  maxEntries: 16,
  maxNameLength: 64,
  /** UTF-8 bytes per value. */
  maxValueBytes: 1_024,
  /** UTF-8 bytes across all values of one request. */
  maxTotalValueBytes: 8_192,
})

/** One submitted name/value pair. An array (never an object map) so a
 * duplicated name is observable instead of silently collapsed by
 * `JSON.parse`. */
export interface UserEnvironmentEntry {
  name: string
  value: string
}

/** Server-only, process-memory-only. Never part of an HTTP response, a
 * durable record, a queue payload, a fingerprint, or `BackendRuntimePlan`.
 * Crosses only the internal process-starter/tmpfs injection boundary, like
 * M10's `GeneratedSecretMaterial`. */
export interface UserEnvironmentMaterial {
  readonly runtimeId: string
  readonly values: ReadonlyMap<string, OpaqueSecretValue>
}

/** Why a declared name is or is not user-configurable -- surfaced to the
 * Side Panel so unsupported names are explained rather than hidden. */
export type UserEnvironmentNameDisposition =
  | "user-configurable"
  | "platform-managed"
  | "generated-secret"
  | "temporary-database"
  | "secret-like-unsupported"
  | "external-routing-unsupported"
  | "client-public-unsupported"
  | "reserved-unsupported"
  | "invalid-name-unsupported"
