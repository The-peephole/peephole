import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg"

import type { SqlResult } from "../preview-api/postgres/database"
import type { TenantAdminSession, TenantDatabaseAdmin } from "./ports"

interface TenantPool {
  connect(): Promise<PoolClient>
  end(): Promise<void>
}

/**
 * Pins each operation to one physical session. No transaction is opened:
 * CREATE/DROP DATABASE must run outside transaction blocks.
 */
export class PostgresTenantAdmin implements TenantDatabaseAdmin {
  private readonly pool: TenantPool

  constructor(config: PoolConfig, pool: TenantPool = new Pool(config)) {
    this.pool = pool
  }

  async withSession<T>(
    operation: (session: TenantAdminSession) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    let discard = false
    const session: TenantAdminSession = {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<SqlResult<Row>> => {
        const result = await client.query<Row>(text, [...values])
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      },
      discard: () => {
        discard = true
      },
    }

    try {
      return await operation(session)
    } finally {
      // node-postgres documents release(true) as destruction rather than
      // returning the physical client to the reusable pool.
      client.release(discard)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
