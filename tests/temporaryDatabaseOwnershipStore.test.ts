import type { QueryResultRow } from "pg"
import { describe, expect, it } from "vitest"

import { validateTemporaryDatabaseResourceId } from "../core/backendDatabase/resourceIdentity"
import { PostgresTemporaryDatabaseOwnershipStore } from "../services/temporary-database/postgresOwnershipStore"
import { TemporaryDatabaseOwnershipError } from "../services/temporary-database/ports"
import type {
  PostgresDatabase,
  SqlResult,
} from "../services/preview-api/postgres/database"
import type {
  TemporaryDatabaseRecord,
  TemporaryDatabaseStatus,
} from "../types/temporaryDatabase"

const resourceId = validateTemporaryDatabaseResourceId(
  "r000102030405060708090a0b0c0d",
)
const createdAt = "2026-09-28T00:00:00.000Z"

describe("PostgresTemporaryDatabaseOwnershipStore", () => {
  it("inserts exactly the credential-free provisioning shape", async () => {
    const database = new ScriptedDatabase([rows([row("provisioning")])])
    const store = new PostgresTemporaryDatabaseOwnershipStore(database)

    await expect(
      store.createProvisioning({
        resourceId,
        previewId: "fullstack-preview-1",
        backendRuntimeId: "backend-runtime-1",
        now: new Date(createdAt),
      }),
    ).resolves.toEqual(record("provisioning"))

    const query = database.queries[0]!
    expect(query.text).toContain("INSERT INTO peephole_temporary_databases")
    expect(query.text).toContain("'provisioning'")
    expect(query.values).toEqual([
      resourceId,
      "fullstack-preview-1",
      "backend-runtime-1",
      new Date(createdAt),
    ])
    expect(query.text).not.toMatch(
      /password|verifier|database_url|credential|connection_string/i,
    )
  })

  it.each([
    ["preview", "peephole_temporary_databases_preview_id_key"],
    ["backend runtime", "peephole_temporary_databases_backend_runtime_id_key"],
  ])("rejects duplicate %s ownership", async (_identity, constraint) => {
    const error = Object.assign(new Error("database rejected duplicate"), {
      code: "23505",
      constraint,
    })
    const store = new PostgresTemporaryDatabaseOwnershipStore(
      new ScriptedDatabase([error]),
    )

    await expect(
      store.createProvisioning({
        resourceId,
        previewId: "fullstack-preview-1",
        backendRuntimeId: "backend-runtime-1",
        now: new Date(createdAt),
      }),
    ).rejects.toMatchObject({
      name: "TemporaryDatabaseOwnershipError",
      code: "CONFLICT",
    })
  })

  it("rejects ownership whose FullStack parent does not exist", async () => {
    const error = Object.assign(new Error("database rejected foreign key"), {
      code: "23503",
    })
    const store = new PostgresTemporaryDatabaseOwnershipStore(
      new ScriptedDatabase([error]),
    )

    await expect(
      store.createProvisioning({
        resourceId,
        previewId: "missing-fullstack-preview",
        backendRuntimeId: "backend-runtime-1",
        now: new Date(createdAt),
      }),
    ).rejects.toMatchObject({
      name: "TemporaryDatabaseOwnershipError",
      code: "OWNER_NOT_FOUND",
    })
  })

  it.each([
    ["markProvisioned", "provisioning", "provisioned"],
    ["markRevoking", "provisioned", "revoking"],
    ["markRevoked", "revoking", "revoked"],
    ["markRevokeFailed", "revoking", "revoke_failed"],
  ] as const)(
    "%s performs one atomic expected-status transition",
    async (method, from, to) => {
      const database = new ScriptedDatabase([rows([row(to)])])
      const store = new PostgresTemporaryDatabaseOwnershipStore(database)

      await expect(
        store[method](resourceId, new Date(createdAt)),
      ).resolves.toEqual(record(to))

      const query = database.queries[0]!
      expect(query.text).toContain("WHERE resource_id = $1 AND status = $2")
      expect(query.text).not.toMatch(
        /SET\s+(resource_id|preview_id|backend_runtime_id|created_at)/i,
      )
      expect(query.values).toEqual([resourceId, from, to, new Date(createdAt)])
    },
  )

  it("fails closed when the expected current status or row is absent", async () => {
    const store = new PostgresTemporaryDatabaseOwnershipStore(
      new ScriptedDatabase([{ rows: [], rowCount: 0 }]),
    )

    await expect(
      store.markProvisioned(resourceId, new Date(createdAt)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<TemporaryDatabaseOwnershipError>>({
        code: "TRANSITION_REJECTED",
      }),
    )
  })

  it("returns stable ISO timestamps from resource and preview lookups", async () => {
    const database = new ScriptedDatabase([
      rows([row("provisioned", new Date(createdAt))]),
      rows([row("provisioned", createdAt)]),
      rows([row("provisioned", createdAt)]),
    ])
    const store = new PostgresTemporaryDatabaseOwnershipStore(database)

    await expect(store.getByResourceId(resourceId)).resolves.toEqual(
      record("provisioned"),
    )
    await expect(store.getByPreviewId("fullstack-preview-1")).resolves.toEqual(
      record("provisioned"),
    )
    await expect(store.listAll()).resolves.toEqual([record("provisioned")])
  })

  it("exposes no unrestricted update API", () => {
    const store = new PostgresTemporaryDatabaseOwnershipStore(
      new ScriptedDatabase([]),
    )
    expect("update" in store).toBe(false)
  })
})

class ScriptedDatabase implements PostgresDatabase {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = []

  constructor(
    private readonly responses: Array<SqlResult<QueryResultRow> | Error>,
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.queries.push({ text, values })
    const response = this.responses.shift() ?? { rows: [], rowCount: 0 }
    if (response instanceof Error) throw response
    return response as SqlResult<Row>
  }

  async transaction<T>(operation: (client: this) => Promise<T>): Promise<T> {
    return operation(this)
  }

  async ping(): Promise<boolean> {
    return true
  }

  async close(): Promise<void> {}
}

function rows<Row extends QueryResultRow>(value: Row[]): SqlResult<Row> {
  return { rows: value, rowCount: value.length }
}

function row(
  status: TemporaryDatabaseStatus,
  timestamp: Date | string = createdAt,
) {
  return {
    resource_id: resourceId,
    preview_id: "fullstack-preview-1",
    backend_runtime_id: "backend-runtime-1",
    status,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

function record(status: TemporaryDatabaseStatus): TemporaryDatabaseRecord {
  return {
    resourceId,
    previewId: "fullstack-preview-1",
    backendRuntimeId: "backend-runtime-1",
    status,
    createdAt,
    updatedAt: createdAt,
  }
}
