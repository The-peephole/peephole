import { Pool, type PoolConfig, type QueryResultRow } from "pg"

export interface SqlResult<Row> {
  rows: Row[]
  rowCount: number
}

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>
}

export interface PostgresDatabase extends SqlExecutor {
  transaction<T>(operation: (client: SqlExecutor) => Promise<T>): Promise<T>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export class PgPoolDatabase implements PostgresDatabase {
  private readonly pool: Pool

  constructor(config: PoolConfig) {
    this.pool = new Pool(config)
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.pool.query<Row>(text, [...values])
    return { rows: result.rows, rowCount: result.rowCount ?? 0 }
  }

  async transaction<T>(
    operation: (client: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    const executor: SqlExecutor = {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        const result = await client.query<Row>(text, [...values])
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      },
    }

    try {
      await client.query("BEGIN")
      const result = await operation(executor)
      await client.query("COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1")
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
