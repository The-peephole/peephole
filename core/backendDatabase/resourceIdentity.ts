import { randomBytes } from "node:crypto"

const RESOURCE_ENTROPY_BYTES = 14
const RESOURCE_ID_PATTERN = /^r[a-f0-9]{28}$/

export type TemporaryDatabaseResourceId = string & {
  readonly __temporaryDatabaseResourceId: unique symbol
}

export type ResourceEntropySource = (size: number) => Uint8Array

/** Mints a server-owned 29-character id with 112 bits of entropy. */
export function mintTemporaryDatabaseResourceId(
  entropySource: ResourceEntropySource = randomBytes,
): TemporaryDatabaseResourceId {
  const entropy = entropySource(RESOURCE_ENTROPY_BYTES)
  if (
    !(entropy instanceof Uint8Array) ||
    entropy.length !== RESOURCE_ENTROPY_BYTES
  ) {
    throw new Error("Temporary database resource entropy is invalid.")
  }

  return validateTemporaryDatabaseResourceId(
    `r${Buffer.from(entropy).toString("hex")}`,
  )
}

export function validateTemporaryDatabaseResourceId(
  value: unknown,
): TemporaryDatabaseResourceId {
  if (typeof value !== "string" || !RESOURCE_ID_PATTERN.test(value)) {
    throw new Error("Temporary database resource id is invalid.")
  }
  return value as TemporaryDatabaseResourceId
}

/** The same physical name will later identify both the database and role. */
export function deriveTemporaryDatabaseObjectName(resourceId: string): string {
  return `pv_${validateTemporaryDatabaseResourceId(resourceId)}`
}
