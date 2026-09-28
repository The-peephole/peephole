import type { QueryResultRow } from "pg"

import {
  deriveTemporaryDatabaseObjectName,
  validateTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../../core/backendDatabase/resourceIdentity"
import type {
  TemporaryDatabaseTenantCatalog,
  TenantDatabaseAdmin,
  TenantPhysicalDatabase,
  TenantPhysicalRole,
  TenantPhysicalSnapshot,
  TenantResourcePresence,
  TenantRoleMembership,
} from "./ports"
import { readProvisioningSessionPolicy } from "./tenantSessionPolicy"

const PEEPHOLE_PREFIX = "pv_"
const PEEPHOLE_OBJECT_PATTERN = /^pv_(r[a-f0-9]{28})$/

interface DatabaseRow extends QueryResultRow {
  name: string
  owner_name: string
  allows_connections: boolean
}

interface RoleRow extends QueryResultRow {
  name: string
  can_login: boolean
  superuser: boolean
  create_database: boolean
  create_role: boolean
  replication: boolean
  bypass_rls: boolean
  connection_limit: number
}

interface MembershipRow extends QueryResultRow {
  granted_role: string
  member_role: string
  admin_option: boolean
  inherit_option: boolean
  set_option: boolean
}

export class PostgresTemporaryDatabaseTenantCatalog implements TemporaryDatabaseTenantCatalog {
  constructor(private readonly tenantAdmin: TenantDatabaseAdmin) {}

  snapshot(): Promise<TenantPhysicalSnapshot> {
    return this.tenantAdmin.withSession(async (session) => {
      const provisioningRole = await readProvisioningSessionPolicy(session)
      const databases = await session.query<DatabaseRow>(
        `
          SELECT datname AS name,
                 pg_get_userbyid(datdba) AS owner_name,
                 datallowconn AS allows_connections
          FROM pg_database
          WHERE LEFT(datname, 3) = $1
          ORDER BY datname ASC
        `,
        [PEEPHOLE_PREFIX],
      )
      const roles = await session.query<RoleRow>(
        `
          SELECT rolname AS name,
                 rolcanlogin AS can_login,
                 rolsuper AS superuser,
                 rolcreatedb AS create_database,
                 rolcreaterole AS create_role,
                 rolreplication AS replication,
                 rolbypassrls AS bypass_rls,
                 rolconnlimit AS connection_limit
          FROM pg_roles
          WHERE LEFT(rolname, 3) = $1
          ORDER BY rolname ASC
        `,
        [PEEPHOLE_PREFIX],
      )
      const memberships = await session.query<MembershipRow>(
        `
          SELECT granted.rolname AS granted_role,
                 member.rolname AS member_role,
                 membership.admin_option,
                 membership.inherit_option,
                 membership.set_option
          FROM pg_auth_members AS membership
          JOIN pg_roles AS granted ON granted.oid = membership.roleid
          JOIN pg_roles AS member ON member.oid = membership.member
          WHERE LEFT(granted.rolname, 3) = $1
             OR LEFT(member.rolname, 3) = $1
          ORDER BY granted.rolname ASC, member.rolname ASC
        `,
        [PEEPHOLE_PREFIX],
      )

      return {
        provisioningRole,
        databases: databases.rows.map(toDatabase),
        roles: toRoles(roles.rows, memberships.rows, provisioningRole),
      }
    })
  }

  inspectResource(
    resourceId: TemporaryDatabaseResourceId,
  ): Promise<TenantResourcePresence> {
    const objectName = deriveTemporaryDatabaseObjectName(
      validateTemporaryDatabaseResourceId(resourceId),
    )
    return this.tenantAdmin.withSession(async (session) => {
      await readProvisioningSessionPolicy(session)
      const result = await session.query<{
        database_exists: boolean
        role_exists: boolean
      }>(
        `
          SELECT
            EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)
              AS database_exists,
            EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1)
              AS role_exists
        `,
        [objectName],
      )
      const row = result.rows[0]
      if (!row) throw new Error("Tenant resource presence is unavailable.")
      return { database: row.database_exists, role: row.role_exists }
    })
  }
}

function toDatabase(row: DatabaseRow): TenantPhysicalDatabase {
  return {
    name: row.name,
    resourceId: resourceIdFromObjectName(row.name),
    ownerName: row.owner_name,
    allowsConnections: row.allows_connections,
  }
}

function toRoles(
  rows: readonly RoleRow[],
  memberships: readonly MembershipRow[],
  provisioningRole: string,
): TenantPhysicalRole[] {
  const physicalNames = new Set(rows.map((row) => row.name))
  const effective = new Map<string, TenantRoleMembership>()
  for (const name of physicalNames) {
    effective.set(name, {
      admin: false,
      set: false,
      inherit: false,
      unexpected: false,
    })
  }

  for (const row of memberships) {
    if (physicalNames.has(row.granted_role)) {
      const current = effective.get(row.granted_role)!
      if (row.member_role === provisioningRole) {
        effective.set(row.granted_role, {
          admin: current.admin || row.admin_option,
          set: current.set || row.set_option,
          inherit: current.inherit || row.inherit_option,
          unexpected: current.unexpected,
        })
      } else {
        effective.set(row.granted_role, { ...current, unexpected: true })
      }
    }
    if (physicalNames.has(row.member_role)) {
      const current = effective.get(row.member_role)!
      effective.set(row.member_role, { ...current, unexpected: true })
    }
  }

  return rows.map((row) => ({
    name: row.name,
    resourceId: resourceIdFromObjectName(row.name),
    canLogin: row.can_login,
    superuser: row.superuser,
    createDatabase: row.create_database,
    createRole: row.create_role,
    replication: row.replication,
    bypassRls: row.bypass_rls,
    connectionLimit: row.connection_limit,
    membership: effective.get(row.name)!,
  }))
}

function resourceIdFromObjectName(
  name: string,
): TemporaryDatabaseResourceId | null {
  const match = PEEPHOLE_OBJECT_PATTERN.exec(name)
  return match ? validateTemporaryDatabaseResourceId(match[1]) : null
}
