import {
  deriveTemporaryDatabaseObjectName,
  validateTemporaryDatabaseResourceId,
} from "./resourceIdentity"
import { createOpaqueSecretValue } from "../backendSecrets/generatedSecretValue"
import type { OpaqueSecretValue } from "../../types/backendRuntimeSecrets"
import type { TemporaryDatabaseCredentialMaterial } from "../../types/temporaryDatabase"

/** Locked network target -- see docs/TEMPORARY_DATABASES.md section 7. Not
 * configurable: this first slice supports exactly one tenant PostgreSQL
 * endpoint, never an arbitrary host/port pair. */
export const TENANT_DATABASE_HOST = "192.168.253.1"
export const TENANT_DATABASE_PORT = 5433

/**
 * Assembles the canonical `postgresql://` connection string for an
 * already-provisioned temporary database, entirely from server-generated
 * material -- never from repository, client, or template input. The raw
 * password is revealed only at this trusted boundary and immediately
 * re-wrapped as an `OpaqueSecretValue`; callers never see it directly.
 *
 * Fails closed if the credential material's `databaseName`/`roleName` do not
 * both exactly equal the object name derived from its own `resourceId` --
 * the one invariant every caller of this builder must be able to trust
 * without re-deriving it themselves.
 */
export function buildTemporaryDatabaseUrl(
  material: TemporaryDatabaseCredentialMaterial,
): OpaqueSecretValue {
  const objectName = deriveTemporaryDatabaseObjectName(
    validateTemporaryDatabaseResourceId(material.resourceId),
  )
  if (
    material.databaseName !== objectName ||
    material.roleName !== objectName
  ) {
    throw new Error(
      "Temporary database credential material identity is invalid.",
    )
  }

  const url = new URL(
    `postgresql://${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/`,
  )
  // Assigning through the setters lets the WHATWG URL implementation apply
  // standard percent-encoding rather than string-concatenating the raw
  // password into the URL text.
  url.username = objectName
  url.password = material.password.reveal()
  url.pathname = `/${objectName}`

  return createOpaqueSecretValue(url.toString())
}
