import { describe, expect, it } from "vitest"
import type { QueryResultRow } from "pg"

import { PostgresPreviewArtifactCache } from "../services/preview-api/postgres/artifactCache"
import { readPostgresConfig } from "../services/preview-api/postgres/config"
import type {
  PostgresDatabase,
  SqlResult,
} from "../services/preview-api/postgres/database"
import { PostgresPreviewJobStore } from "../services/preview-api/postgres/jobStore"
import { applyPostgresMigrations } from "../services/preview-api/postgres/migrate"
import { PostgresPreviewQueue } from "../services/preview-api/postgres/queue"
import { PostgresPreviewQuota } from "../services/preview-api/postgres/quota"
import type { StoredPreviewJob } from "../services/preview-api/ports"

const job: StoredPreviewJob = {
  id: "job-00000001",
  requesterId: "user-1",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  plan: {
    contractVersion: "static-v1",
    repository: {
      repositoryId: 1,
      owner: "acme",
      name: "web",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceRoot: ".",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDirectory: "dist",
  },
  cacheKey: "cache-key",
  cacheStatus: "miss",
  status: "queued",
  artifact: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-02T01:00:00.000Z",
}

describe("PostgreSQL preview adapters", () => {
  it("persists a job with parameterized JSON and idempotency", async () => {
    const database = new ScriptedDatabase([rows([jobRow(job)])])
    const store = new PostgresPreviewJobStore(database)

    await expect(
      store.createOrGet({
        requesterId: "user-1",
        idempotencyKey: "request-0000000001",
        requestFingerprint: "fingerprint",
        job,
      }),
    ).resolves.toMatchObject({ created: true, job })

    expect(database.transactionCount).toBe(1)
    expect(database.queries[0]?.text).toContain("ON CONFLICT")
    expect(database.queries[0]?.text).toContain("$5::jsonb")
    expect(database.queries[0]?.values?.[1]).toBe("user-1")
  })

  it("locks a job row while applying state transitions", async () => {
    const updated = { ...job, status: "fetching" as const }
    const database = new ScriptedDatabase([
      rows([jobRow(job)]),
      rows([jobRow(updated)]),
    ])
    const store = new PostgresPreviewJobStore(database)

    await expect(
      store.update(job.id, (current) => ({ ...current, status: "fetching" })),
    ).resolves.toMatchObject({ status: "fetching" })

    expect(database.queries[0]?.text).toContain("FOR UPDATE")
    expect(database.queries[1]?.text).toContain("UPDATE peephole_preview_jobs")
  })

  it("leases queue rows with SKIP LOCKED and supports ack/release", async () => {
    const queued = {
      jobId: job.id,
      repository: job.repository,
      plan: job.plan,
      cacheKey: job.cacheKey,
    }
    const database = new ScriptedDatabase([
      rows([{ payload: queued, attempts: 1 }]),
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ])
    const queue = new PostgresPreviewQueue(database)

    await expect(
      queue.lease("worker-1", new Date(job.createdAt), 300_000),
    ).resolves.toEqual({ job: queued, attempts: 1 })
    await expect(queue.acknowledge(job.id, "worker-1")).resolves.toBe(true)
    await expect(
      queue.release(job.id, "worker-1", new Date(job.updatedAt)),
    ).resolves.toBe(true)

    expect(database.queries[0]?.text).toContain("FOR UPDATE SKIP LOCKED")
    expect(database.queries[0]?.text).toContain("lease_expires_at")
  })

  it("uses a transaction and hashed quota scopes", async () => {
    const database = new ScriptedDatabase([
      rows([{ request_count: 1 }]),
      rows([{ request_count: 1 }]),
      rows([{ request_count: 1 }]),
    ])
    const quota = new PostgresPreviewQuota(database)

    await expect(
      quota.consume(
        { subject: "secret-user-id", ip: "203.0.113.1" },
        job.repository,
        new Date(job.createdAt),
      ),
    ).resolves.toEqual({ allowed: true })

    expect(database.transactionCount).toBe(1)
    expect(database.queries[0]?.values?.[0]).toMatch(/^[a-f\d]{64}$/)
    expect(database.queries[0]?.values).not.toContain("secret-user-id")
  })

  it("reads and upserts unexpired artifact cache entries", async () => {
    const database = new ScriptedDatabase([
      rows([{ artifact_id: "artifact-1", expires_at: job.expiresAt }]),
      { rows: [], rowCount: 1 },
    ])
    const cache = new PostgresPreviewArtifactCache(database)

    await expect(
      cache.get("cache-key", new Date(job.createdAt)),
    ).resolves.toEqual({
      artifactId: "artifact-1",
      expiresAt: new Date(job.expiresAt),
    })
    await cache.put("cache-key", "artifact-1", new Date(job.expiresAt))

    expect(database.queries[1]?.text).toContain("ON CONFLICT")
  })

  it("loads the idempotent initial migration", async () => {
    const database = new ScriptedDatabase([{ rows: [], rowCount: 0 }])
    await applyPostgresMigrations(database)

    expect(database.queries[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS peephole_preview_jobs",
    )
    expect(database.queries[0]?.text).toContain("peephole_preview_queue")
  })
})

describe("PostgreSQL configuration", () => {
  it("requires TLS for remote databases and allows local development", () => {
    expect(
      readPostgresConfig({
        PEEPHOLE_DATABASE_URL: "postgres://user:pass@db.example.test/peephole",
      }).pool.ssl,
    ).toMatchObject({ rejectUnauthorized: true })
    expect(
      readPostgresConfig({
        PEEPHOLE_DATABASE_URL: "postgres://localhost/peephole",
      }).pool.ssl,
    ).toBe(false)
  })

  it("rejects missing, insecurely overridden, and oversized pool settings", () => {
    expect(() => readPostgresConfig({})).toThrow("required")
    expect(() =>
      readPostgresConfig({
        PEEPHOLE_DATABASE_URL: "postgres://db.example.test/db?sslmode=disable",
      }),
    ).toThrow("sslmode")
    expect(() =>
      readPostgresConfig({
        PEEPHOLE_DATABASE_URL: "postgres://localhost/db",
        PEEPHOLE_DATABASE_POOL_SIZE: "100",
      }),
    ).toThrow("between 1 and 50")
  })
})

class ScriptedDatabase implements PostgresDatabase {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = []
  transactionCount = 0

  constructor(private readonly responses: Array<SqlResult<QueryResultRow>>) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.queries.push({ text, values })
    const response = this.responses.shift() ?? { rows: [], rowCount: 0 }
    return response as SqlResult<Row>
  }

  async transaction<T>(
    operation: (client: ScriptedDatabase) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1
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

function jobRow(value: StoredPreviewJob) {
  return {
    id: value.id,
    requester_id: value.requesterId,
    idempotency_key: "request-0000000001",
    request_fingerprint: "fingerprint",
    repository: value.repository,
    plan: value.plan,
    cache_key: value.cacheKey,
    cache_status: value.cacheStatus,
    status: value.status,
    artifact: value.artifact,
    error_code: value.errorCode,
    error_message: value.errorMessage,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    expires_at: value.expiresAt,
  }
}
