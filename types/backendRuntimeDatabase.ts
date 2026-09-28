/** The only temporary-database capability admitted by M11's first slice. */
export const BACKEND_RUNTIME_DATABASE_ENV_NAME = "DATABASE_URL"

/**
 * Names-only capability metadata. Values and connection coordinates must
 * never be added to this portable contract.
 */
export interface BackendRuntimeDatabaseRequirement {
  readonly name: typeof BACKEND_RUNTIME_DATABASE_ENV_NAME
}
