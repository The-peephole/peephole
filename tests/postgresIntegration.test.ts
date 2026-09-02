import { randomUUID } from "node:crypto"
import type { QueryResultRow } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readPostgresConfig } from "../services/preview-api/postgres/config"
import { PgPoolDatabase } from "../services/preview-api/postgres/database"
import { PostgresPreviewJobStore } from "../services/preview-api/postgres/jobStore"
import { applyPostgresMigrations } from "../services/preview-api/postgres/migrate"
import { PostgresPreviewQueue } from "../services/preview-api/postgres/queue"
import type { StoredPreviewJob } from "../services/preview-api/ports"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const describeWithPostgres = connectionString ? describe : describe.skip

describeWithPostgres("PostgreSQL integration", () => {
  let database: PgPoolDatabase
  const jobIds: string[] = []

  beforeAll(async () => {
    database = new PgPoolDatabase(
      readPostgresConfig({
        PEEPHOLE_DATABASE_URL: connectionString,
        PEEPHOLE_DATABASE_POOL_SIZE: "4",
      }).pool,
    )
    await applyPostgresMigrations(database)
  })

  afterAll(async () => {
    if (!database) return

    for (const jobId of jobIds) {
      await database
        .query("DELETE FROM peephole_preview_jobs WHERE id = $1", [jobId])
        .catch(() => undefined)
    }
    await database.close()
  })

  it("persists jobs, gives one lease to one worker, and recovers an expired lease", async () => {
    const store = new PostgresPreviewJobStore(database)
    const queue = new PostgresPreviewQueue(database)
    const first = createJob()
    jobIds.push(first.id)

    await store.createOrGet({
      requesterId: first.requesterId,
      idempotencyKey: `request-${first.id}`,
      requestFingerprint: `fingerprint-${first.id}`,
      job: first,
    })
    await queue.enqueue(toQueuedJob(first))

    const now = new Date()
    const leases = await Promise.all([
      queue.lease("integration-worker-a", now, 1_000),
      queue.lease("integration-worker-b", now, 1_000),
    ])
    const winner = leases.find((lease) => lease !== null)

    expect(leases.filter((lease) => lease !== null)).toHaveLength(1)
    expect(winner?.job.jobId).toBe(first.id)
    await expect(
      queue.acknowledge(
        first.id,
        leases[0] ? "integration-worker-a" : "integration-worker-b",
      ),
    ).resolves.toBe(true)

    const second = createJob()
    jobIds.push(second.id)
    await store.createOrGet({
      requesterId: second.requesterId,
      idempotencyKey: `request-${second.id}`,
      requestFingerprint: `fingerprint-${second.id}`,
      job: second,
    })
    await queue.enqueue(toQueuedJob(second))
    const secondLeaseTime = new Date()

    await expect(
      queue.lease("integration-worker-a", secondLeaseTime, 1_000),
    ).resolves.toMatchObject({ attempts: 1 })
    const leasedRow = await database.query<LeaseExpiryRow>(
      `
        SELECT lease_expires_at
        FROM peephole_preview_queue
        WHERE job_id = $1
      `,
      [second.id],
    )
    const leaseExpiresAt = leasedRow.rows[0]?.lease_expires_at

    if (!leaseExpiresAt) {
      throw new Error("Expected the integration queue row to have a lease.")
    }

    await expect(
      queue.lease(
        "integration-worker-b",
        new Date(new Date(leaseExpiresAt).getTime() + 1),
        1_000,
      ),
    ).resolves.toMatchObject({
      job: { jobId: second.id },
      attempts: 2,
    })
  })
})

interface LeaseExpiryRow extends QueryResultRow {
  lease_expires_at: Date | string
}

function createJob(): StoredPreviewJob {
  const id = randomUUID()
  const now = new Date()
  const repository = {
    repositoryId: Math.floor(Math.random() * 1_000_000_000) + 1,
    owner: "peephole-integration",
    name: "fixture",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  }

  return {
    id,
    requesterId: `integration-${id}`,
    repository,
    plan: {
      contractVersion: "static-v1",
      repository,
      sourceRoot: ".",
      packageManager: "none",
      installCommand: null,
      buildCommand: null,
      outputDirectory: ".",
    },
    cacheKey: `cache-${id}`,
    cacheStatus: "miss",
    status: "queued",
    artifact: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
}

function toQueuedJob(job: StoredPreviewJob) {
  return {
    jobId: job.id,
    repository: job.repository,
    plan: job.plan,
    cacheKey: job.cacheKey,
  }
}
