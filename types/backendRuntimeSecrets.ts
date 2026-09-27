/**
 * M10 foundation types -- see docs/EPHEMERAL_SECRETS.md and
 * docs/DECISIONS.md's D-032 for the full design. NOT wired into any
 * production path: `BackendRuntimePlan.platformEnvironment`
 * (`types/backendRuntime.ts`) is unchanged and still contains only `PORT`,
 * `HOST`, `NODE_ENV`; nothing here is reachable from
 * `CreateBackendRuntimeRequest`, `BackendRuntime`'s public HTTP shape,
 * `FullStackPreview`'s public HTTP shape, or any PostgreSQL-backed type.
 *
 * M10-B's internal process starter may receive `GeneratedSecretMaterial`
 * directly for injection tests, but the production supervisor always passes
 * `null`; no broker/admission/HTTP/durable-store wiring exists.
 *
 * This is the single canonical source for the fixed preview-generated
 * secret name allowlist -- `core/analyzer/environmentRequirements.ts`
 * imports `PREVIEW_GENERATED_SECRET_NAME_SET` from here rather than
 * maintaining its own copy, so the two can never silently diverge.
 */

/** Deliberately a literal list, never derived from a regex -- the only
 * names a *future* (not yet implemented) generation step may ever produce.
 * See docs/EPHEMERAL_SECRETS.md section 5 for why this stays fixed. */
export const PREVIEW_GENERATED_SECRET_NAMES = [
  "JWT_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "CSRF_SECRET",
] as const

export type PreviewGeneratedSecretName =
  (typeof PREVIEW_GENERATED_SECRET_NAMES)[number]

// Deliberately typed `ReadonlySet<string>` rather than
// `ReadonlySet<PreviewGeneratedSecretName>`: its main caller
// (`core/analyzer/environmentRequirements.ts`) is checking membership for an
// arbitrary declared template name, which is a plain `string` until this
// check narrows it -- narrowing the set's own type would just force an
// unsound cast at every call site instead.
export const PREVIEW_GENERATED_SECRET_NAME_SET: ReadonlySet<string> = new Set(
  PREVIEW_GENERATED_SECRET_NAMES,
)

/**
 * Opaque by construction: the only way to obtain the raw bytes is the
 * explicit `reveal()` call. See `core/backendSecrets/generatedSecretValue.ts`
 * for the factory -- there is deliberately no public constructor here, and
 * no implementation stores the raw value as an enumerable property of the
 * returned object (see that module's doc comment for why).
 */
export interface OpaqueSecretValue {
  reveal(): string
}

/**
 * Server-only, process-memory-only. Never added to
 * `CreateBackendRuntimeRequest`, `BackendRuntimePlan`, `QueuedBackendRuntime`,
 * `BackendRuntime`'s public shape, or any type that crosses an HTTP response
 * or a durable (PostgreSQL / in-memory *store*) record. It is held by the
 * process-local broker and, once consumed in a later phase, may cross only
 * the internal process-starter/tmpfs injection boundary.
 */
export interface GeneratedSecretMaterial {
  readonly runtimeId: string
  readonly values: ReadonlyMap<PreviewGeneratedSecretName, OpaqueSecretValue>
}
