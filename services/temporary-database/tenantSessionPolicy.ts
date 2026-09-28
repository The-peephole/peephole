import type { TenantAdminSession } from "./ports"

const SAFE_POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

export async function readProvisioningSessionPolicy(
  session: TenantAdminSession,
): Promise<string> {
  const provisioningRole = await readProvisioningSessionIdentity(session)
  const result = await session.query<{ createrole_self_grant: string }>(
    "SHOW createrole_self_grant",
  )
  if (result.rows[0]?.createrole_self_grant !== "") {
    throw new Error("Tenant role self-grant policy is unsafe.")
  }
  return provisioningRole
}

export async function readProvisioningSessionIdentity(
  session: TenantAdminSession,
): Promise<string> {
  const result = await session.query<{
    session_user: string
    current_user: string
  }>("SELECT session_user AS session_user, current_user AS current_user")
  const sessionUser = result.rows[0]?.session_user
  const currentUser = result.rows[0]?.current_user
  assertSafePostgresIdentifier(sessionUser)
  assertSafePostgresIdentifier(currentUser)
  if (sessionUser !== currentUser) {
    throw new Error("Tenant administrative session identity is unsafe.")
  }
  return sessionUser
}

export async function withTemporaryDatabaseRole<T>(
  session: TenantAdminSession,
  roleName: string,
  expectedProvisioningRole: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertSafePostgresIdentifier(roleName)
  assertSafePostgresIdentifier(expectedProvisioningRole)
  await session.query(`SET ROLE ${roleName}`)
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }

  try {
    await session.query("RESET ROLE")
  } catch {
    session.discard()
    throw new Error("Tenant administrative session could not reset role.")
  }

  try {
    const restoredRole = await readProvisioningSessionIdentity(session)
    if (restoredRole !== expectedProvisioningRole) {
      throw new Error(
        "Tenant administrative session identity was not restored.",
      )
    }
  } catch {
    session.discard()
    throw new Error("Tenant administrative session identity is unproven.")
  }

  if (!outcome.ok) throw outcome.error
  return outcome.value
}

export function assertSafePostgresIdentifier(
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || !SAFE_POSTGRES_IDENTIFIER.test(value)) {
    throw new Error("PostgreSQL administrative identifier is unsafe.")
  }
}
