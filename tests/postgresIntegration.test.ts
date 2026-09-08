import { randomUUID } from "node:crypto"
import type { QueryResultRow } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readPostgresConfig } from "../services/preview-api/postgres/config"
import { PgPoolDatabase } from "../services/preview-api/postgres/database"
import { PostgresPreviewJobStore } from "../services/preview-api/postgres/jobStore"
import { applyPostgresMigrations } from "../services/preview-api/postgres/migrate"
import { PostgresProductionArtifactStore } from "../services/preview-api/postgres/productionArtifactStore"
import { PostgresPreviewQueue } from "../services/preview-api/postgres/queue"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
} from "../services/preview-api/inMemoryAdapters"
import type { StoredPreviewJob } from "../services/preview-api/ports"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const describeWithPostgres = connectionString ? describe : describe.skip

describeWithPostgres("PostgreSQL integration", () => {
  let database: PgPoolDatabase
  const jobIds: string[] = []
  const productionArtifactIds: string[] = []

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
    for (const artifactId of productionArtifactIds) {
      await database
        .query(
          "DELETE FROM peephole_production_artifacts WHERE artifact_id = $1",
          [artifactId],
        )
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
    // No separate enqueue: persistence must atomically admit the job to the queue.

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
        winner!.attempts,
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
    await expect(
      queue.acknowledge(second.id, "integration-worker-a", 1),
    ).resolves.toBe(false)
    await expect(
      queue.release(second.id, "integration-worker-a", new Date(), 1),
    ).resolves.toBe(false)
    await expect(
      queue.renew(second.id, "integration-worker-a", 1, 1000),
    ).resolves.toBe(false)
    await expect(
      queue.renew(second.id, "integration-worker-b", 2, 1000),
    ).resolves.toBe(true)
    await expect(
      queue.acknowledge(second.id, "integration-worker-b", 2),
    ).resolves.toBe(true)
  })

  it("commits one job and one delivery for concurrent identical requests", async () => {
    // Two concurrent attempts at the same logical request never share a
    // candidate row id -- PreviewControlPlane.create mints a fresh
    // crypto.randomUUID() per call before persistence is attempted, exactly
    // like the two candidates here. Only requesterId/idempotencyKey (the
    // createOrGet arbiter) are expected to collide.
    const first = createJob()
    const second = { ...createJob(), requesterId: first.requesterId }
    jobIds.push(first.id, second.id)
    const store = new PostgresPreviewJobStore(database)
    const idempotencyKey = `request-${first.id}`
    const input = {
      requesterId: first.requesterId,
      idempotencyKey,
      requestFingerprint: "same-request",
    }
    const results = await Promise.all([
      store.createOrGet({ ...input, job: first }),
      store.createOrGet({ ...input, job: second }),
    ])
    const created = results.filter((result) => result.created)
    expect(created).toHaveLength(1)
    const wonJobId = created[0]!.job.id
    const rows = await database.query(
      "SELECT job_id FROM peephole_preview_queue WHERE job_id = $1",
      [wonJobId],
    )
    expect(rows.rowCount).toBe(1)
    await database.query(
      "DELETE FROM peephole_preview_queue WHERE job_id = $1",
      [wonJobId],
    )
  })

  it("rolls back job persistence when queue insertion cannot commit", async () => {
    const job = createJob()
    jobIds.push(job.id)
    const store = new PostgresPreviewJobStore({
      query: database.query.bind(database),
      ping: database.ping.bind(database),
      close: async () => undefined,
      transaction: (operation) =>
        database.transaction((client) =>
          operation({
            query: async (sql, values) => {
              const result = await client.query(sql, values)
              if (sql.includes("INSERT INTO peephole_preview_queue"))
                throw new Error("simulated transaction failure")
              return result as never
            },
          }),
        ),
    })
    await expect(
      store.createOrGet({
        requesterId: job.requesterId,
        idempotencyKey: `request-${job.id}`,
        requestFingerprint: "rollback",
        job,
      }),
    ).rejects.toThrow("simulated transaction failure")
    expect(await store.get(job.id)).toBeNull()
    expect(
      (
        await database.query(
          "SELECT job_id FROM peephole_preview_queue WHERE job_id = $1",
          [job.id],
        )
      ).rowCount,
    ).toBe(0)
  })

  it("observes cancellation from another control-plane connection", async () => {
    const job = createJob()
    jobIds.push(job.id)
    const otherDatabase = new PgPoolDatabase(
      readPostgresConfig({ PEEPHOLE_DATABASE_URL: connectionString }).pool,
    )
    const makeControl = (db: PgPoolDatabase) =>
      new PreviewControlPlane(
        { resolve: async () => job.plan },
        new PostgresPreviewJobStore(db),
        new PostgresPreviewQueue(db),
        new InMemoryPreviewArtifactCache(),
        new HmacPreviewArtifactSigner(
          "peephole.run",
          "test-secret-at-least-thirty-two-bytes",
        ),
        new FixedWindowPreviewQuota(),
        { runnerVersion: "test" },
      )
    try {
      await new PostgresPreviewJobStore(database).createOrGet({
        requesterId: job.requesterId,
        idempotencyKey: `request-${job.id}`,
        requestFingerprint: "cancel-test",
        job,
      })
      const workerControl = makeControl(database)
      await workerControl.startWorkerJob(job.id)
      expect(await workerControl.isWorkerJobActive(job.id)).toBe(true)
      await makeControl(otherDatabase).cancel(job.id, {
        subject: job.requesterId,
        ip: "127.0.0.1",
      })
      expect(await workerControl.isWorkerJobActive(job.id)).toBe(false)
      expect(
        (await new PostgresPreviewJobStore(otherDatabase).get(job.id))?.status,
      ).toBe("cancelled")
    } finally {
      await otherDatabase.close()
    }
  })

  it("PostgresProductionArtifactStore never shrinks an artifact's persisted expiry", async () => {
    const artifactId = `artifact-${randomUUID()}`
    productionArtifactIds.push(artifactId)
    const store = new PostgresProductionArtifactStore(database)
    const longExpiry = new Date(Date.now() + 60_000)
    const shortExpiry = new Date(Date.now() + 5_000)

    await store.upsertMaxExpiry(artifactId, longExpiry)
    // A build-cache hit re-signing the same artifact for a new job with a
    // shorter expiry than it already has must not cut the persisted
    // expiry short -- this is exactly the real SQL (GREATEST(...) in an
    // ON CONFLICT DO UPDATE), not just application-level logic, so it's
    // worth proving against a real database.
    await store.upsertMaxExpiry(artifactId, shortExpiry)

    const metadata = await store.get(artifactId)
    expect(metadata?.expiresAt.getTime()).toBe(longExpiry.getTime())

    // ... but a *later*, longer expiry still extends it.
    const longerExpiry = new Date(Date.now() + 120_000)
    await store.upsertMaxExpiry(artifactId, longerExpiry)
    expect((await store.get(artifactId))?.expiresAt.getTime()).toBe(
      longerExpiry.getTime(),
    )
  })

  it("PostgresProductionArtifactStore lists expired artifacts and conditionally deletes them", async () => {
    const expiredId = `artifact-${randomUUID()}`
    const activeId = `artifact-${randomUUID()}`
    productionArtifactIds.push(expiredId, activeId)
    const store = new PostgresProductionArtifactStore(database)
    const now = new Date()

    await store.upsertMaxExpiry(expiredId, new Date(now.getTime() - 1_000))
    await store.upsertMaxExpiry(activeId, new Date(now.getTime() + 60_000))

    const expired = await store.listExpired(now)
    expect(expired).toContain(expiredId)
    expect(expired).not.toContain(activeId)

    await expect(store.deleteIfStillExpired(expiredId, now)).resolves.toBe(true)
    expect(await store.get(expiredId)).toBeNull()
    expect(await store.get(activeId)).not.toBeNull()
  })

  it("PostgresProductionArtifactStore.deleteIfStillExpired refuses to delete a row a concurrent sign() just extended -- the reaper/re-sign race", async () => {
    // This is the real SQL a ProductionArtifactHost.reap() candidate check
    // runs against: `listExpired()` gave a stale snapshot; by the time the
    // conditional DELETE actually runs, a concurrent upsertMaxExpiry() (a
    // build-cache hit re-signing the same artifact) may have already
    // extended it into the future. The atomic `WHERE expires_at <= $2`
    // must see that and refuse to delete, not the stale snapshot.
    const artifactId = `artifact-${randomUUID()}`
    productionArtifactIds.push(artifactId)
    const store = new PostgresProductionArtifactStore(database)
    const now = new Date()

    await store.upsertMaxExpiry(artifactId, new Date(now.getTime() - 1_000))
    const staleCandidates = await store.listExpired(now)
    expect(staleCandidates).toContain(artifactId)

    // The race: a concurrent sign() lands between the listing above and
    // the delete attempt below.
    await store.upsertMaxExpiry(artifactId, new Date(now.getTime() + 60_000))

    await expect(store.deleteIfStillExpired(artifactId, now)).resolves.toBe(
      false,
    )
    expect((await store.get(artifactId))?.expiresAt.getTime()).toBe(
      now.getTime() + 60_000,
    )
  })

  it("applyPostgresMigrations is safe to run again against an already-migrated database", async () => {
    // beforeAll already ran every migration once to set this schema up;
    // production runs applyPostgresMigrations() on every process start,
    // against a database that already has 001 (and, after this change,
    // 002) applied -- this proves that repeat is a genuine no-op, not
    // just that a fresh, empty schema accepts the SQL once.
    const artifactId = `artifact-${randomUUID()}`
    productionArtifactIds.push(artifactId)
    const store = new PostgresProductionArtifactStore(database)
    const expiresAt = new Date(Date.now() + 60_000)
    await store.upsertMaxExpiry(artifactId, expiresAt)

    await expect(applyPostgresMigrations(database)).resolves.toBeUndefined()
    await expect(applyPostgresMigrations(database)).resolves.toBeUndefined()

    // Existing data untouched by re-running CREATE TABLE/INDEX IF NOT
    // EXISTS migrations a second and third time.
    expect((await store.get(artifactId))?.expiresAt.getTime()).toBe(
      expiresAt.getTime(),
    )
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
