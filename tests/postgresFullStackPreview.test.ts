import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createFullStackPreviewId } from "../services/fullstack-preview-api/id"
import { PostgresFullStackPreviewStore } from "../services/fullstack-preview-api/postgres/previewStore"
import { PostgresFullStackPreviewQueue } from "../services/fullstack-preview-api/postgres/queue"
import type { StoredFullStackPreview } from "../services/fullstack-preview-api/ports"
import { readPostgresConfig } from "../services/preview-api/postgres/config"
import { PgPoolDatabase } from "../services/preview-api/postgres/database"
import { applyPostgresMigrations } from "../services/preview-api/postgres/migrate"
import { PostgresPreviewJobStore } from "../services/preview-api/postgres/jobStore"
import { PostgresProductionArtifactStore } from "../services/preview-api/postgres/productionArtifactStore"
import type { StoredPreviewJob } from "../services/preview-api/ports"

const connectionString = process.env.PEEPHOLE_POSTGRES_TEST_URL
const describeWithPostgres = connectionString ? describe : describe.skip

describeWithPostgres("PostgreSQL integration: FullStackPreview", () => {
  let database: PgPoolDatabase
  const previewIds: string[] = []
  const jobIds: string[] = []
  const artifactIds: string[] = []

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
    for (const previewId of previewIds) {
      await database
        .query("DELETE FROM peephole_fullstack_previews WHERE id = $1", [
          previewId,
        ])
        .catch(() => undefined)
    }
    for (const jobId of jobIds) {
      await database
        .query("DELETE FROM peephole_preview_jobs WHERE id = $1", [jobId])
        .catch(() => undefined)
    }
    for (const artifactId of artifactIds) {
      await database
        .query(
          "DELETE FROM peephole_production_artifacts WHERE artifact_id = $1",
          [artifactId],
        )
        .catch(() => undefined)
    }
    await database.close()
  })

  it("persists a preview with null child ids, leases it, and recovers an expired lease", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const queue = new PostgresFullStackPreviewQueue(database)
    const first = createPreview()
    previewIds.push(first.id)

    const admitted = await store.createOrGetWithCapacity({
      requesterId: first.requesterId,
      idempotencyKey: `request-${first.id}`,
      requestFingerprint: `fingerprint-${first.id}`,
      preview: first,
      maxActive: 1,
    })
    expect(admitted.created).toBe(true)
    expect(admitted.enqueued).toBe(true)
    expect(admitted.preview.frontendJobId).toBeNull()
    expect(admitted.preview.artifactId).toBeNull()
    expect(admitted.preview.backendRuntimeId).toBeNull()

    const now = new Date()
    const leases = await Promise.all([
      queue.lease("integration-worker-a", now, 1_000),
      queue.lease("integration-worker-b", now, 1_000),
    ])
    const winner = leases.find((lease) => lease !== null)
    expect(leases.filter((lease) => lease !== null)).toHaveLength(1)
    expect(winner?.preview.previewId).toBe(first.id)

    await expect(
      queue.acknowledge(
        first.id,
        leases[0] ? "integration-worker-a" : "integration-worker-b",
        winner!.attempts,
      ),
    ).resolves.toBe(true)

    const second = createPreview()
    previewIds.push(second.id)
    await store.createOrGetWithCapacity({
      requesterId: second.requesterId,
      idempotencyKey: `request-${second.id}`,
      requestFingerprint: `fingerprint-${second.id}`,
      preview: second,
      maxActive: 1,
    })
    const secondLeaseTime = new Date()

    await expect(
      queue.lease("integration-worker-a", secondLeaseTime, 1_000),
    ).resolves.toMatchObject({ attempts: 1 })

    const leasedRow = await database.query<{ lease_expires_at: Date | string }>(
      "SELECT lease_expires_at FROM peephole_fullstack_queue WHERE preview_id = $1",
      [second.id],
    )
    const leaseExpiresAt = leasedRow.rows[0]?.lease_expires_at
    if (!leaseExpiresAt) {
      throw new Error("Expected the integration queue row to have a lease.")
    }

    // The winning worker never acknowledges -- prove the expired lease can
    // be reclaimed by a different worker (SKIP LOCKED, attempt increments).
    await expect(
      queue.lease(
        "integration-worker-b",
        new Date(new Date(leaseExpiresAt).getTime() + 1),
        1_000,
      ),
    ).resolves.toMatchObject({
      preview: { previewId: second.id },
      attempts: 2,
    })
    // Stale first lease no longer owns the row.
    await expect(
      queue.acknowledge(second.id, "integration-worker-a", 1),
    ).resolves.toBe(false)
    await expect(
      queue.release(second.id, "integration-worker-a", new Date(), 1),
    ).resolves.toBe(false)
    await expect(
      queue.renew(second.id, "integration-worker-a", 1, 1_000),
    ).resolves.toBe(false)
    // Current owner can renew and then acknowledge.
    await expect(
      queue.renew(second.id, "integration-worker-b", 2, 1_000),
    ).resolves.toBe(true)
    await expect(
      queue.acknowledge(second.id, "integration-worker-b", 2),
    ).resolves.toBe(true)
  })

  it("releases an owned lease and permanently excludes a cancelled delivery", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const queue = new PostgresFullStackPreviewQueue(database)
    const released = createPreview()
    previewIds.push(released.id)
    await store.createOrGetWithCapacity({
      requesterId: released.requesterId,
      idempotencyKey: `request-${released.id}`,
      requestFingerprint: `fingerprint-${released.id}`,
      preview: released,
      maxActive: 1,
    })

    const firstLease = await queue.lease(
      "integration-release-a",
      new Date(),
      1_000,
    )
    expect(firstLease?.preview.previewId).toBe(released.id)
    await expect(
      queue.release(
        released.id,
        "integration-release-a",
        new Date(0),
        firstLease!.attempts,
      ),
    ).resolves.toBe(true)

    const secondLease = await queue.lease(
      "integration-release-b",
      new Date(),
      1_000,
    )
    expect(secondLease).toMatchObject({
      preview: { previewId: released.id },
      attempts: 2,
    })
    await expect(
      queue.acknowledge(
        released.id,
        "integration-release-b",
        secondLease!.attempts,
      ),
    ).resolves.toBe(true)

    const cancelled = createPreview()
    previewIds.push(cancelled.id)
    await store.createOrGetWithCapacity({
      requesterId: cancelled.requesterId,
      idempotencyKey: `request-${cancelled.id}`,
      requestFingerprint: `fingerprint-${cancelled.id}`,
      preview: cancelled,
      maxActive: 1,
    })
    await queue.cancel(cancelled.id)

    await expect(
      queue.lease("integration-after-cancel", new Date(), 1_000),
    ).resolves.toBeNull()
    const cancelledRow = await database.query<{ status: string }>(
      "SELECT status FROM peephole_fullstack_queue WHERE preview_id = $1",
      [cancelled.id],
    )
    expect(cancelledRow.rows[0]?.status).toBe("cancelled")
  })

  it("persists no backend network coordinates", async () => {
    const columns = await database.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'peephole_fullstack_previews'
      `,
    )
    const names = columns.rows.map((row) => row.column_name)

    for (const forbidden of [
      "peer_ip",
      "dial_target",
      "dial_target_host",
      "dial_target_port",
      "internal_port",
      "backend_host",
      "backend_port",
      "backend_url",
      "requester_ip",
      "request_ip",
      "ip",
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it("migration 004 persists awaiting_activation and remains idempotent", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const preview = createPreview()
    previewIds.push(preview.id)
    await store.createOrGetWithCapacity({
      requesterId: preview.requesterId,
      idempotencyKey: `request-${preview.id}`,
      requestFingerprint: `fingerprint-${preview.id}`,
      preview,
      maxActive: 1,
    })
    const updated = await store.update(preview.id, (current) => ({
      ...current,
      status: "awaiting_activation",
    }))
    expect(updated.status).toBe("awaiting_activation")
    await expect(applyPostgresMigrations(database)).resolves.toBeUndefined()
    expect((await store.get(preview.id))?.status).toBe("awaiting_activation")
  })

  it("admits exactly one of two concurrent distinct requests at limit 1", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const first = createPreview()
    const second = { ...createPreview(), requesterId: first.requesterId }
    previewIds.push(first.id, second.id)

    const results = await Promise.allSettled([
      store.createOrGetWithCapacity({
        requesterId: first.requesterId,
        idempotencyKey: `first-${first.id}`,
        requestFingerprint: `first-${first.id}`,
        preview: first,
        maxActive: 1,
      }),
      store.createOrGetWithCapacity({
        requesterId: second.requesterId,
        idempotencyKey: `second-${second.id}`,
        requestFingerprint: `second-${second.id}`,
        preview: second,
        maxActive: 1,
      }),
    ])
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof store.createOrGetWithCapacity>>
      > => result.status === "fulfilled",
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )

    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]!.value.created).toBe(true)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    })
    await expect(countAdmissions(database, first.requesterId)).resolves.toEqual(
      { active: 1, queued: 1 },
    )
  })

  it("commits one preview and one delivery for concurrent identical requests (atomic create + enqueue)", async () => {
    const first = createPreview()
    const second = { ...createPreview(), requesterId: first.requesterId }
    previewIds.push(first.id, second.id)
    const store = new PostgresFullStackPreviewStore(database)
    const idempotencyKey = `request-${first.id}`
    const input = {
      requesterId: first.requesterId,
      idempotencyKey,
      requestFingerprint: "same-request",
      maxActive: 1,
    }

    const results = await Promise.all([
      store.createOrGetWithCapacity({ ...input, preview: first }),
      store.createOrGetWithCapacity({ ...input, preview: second }),
    ])
    const created = results.filter((result) => result.created)
    expect(created).toHaveLength(1)
    const wonPreviewId = created[0]!.preview.id
    expect(new Set(results.map((result) => result.preview.id))).toEqual(
      new Set([wonPreviewId]),
    )

    const rows = await database.query(
      "SELECT preview_id FROM peephole_fullstack_queue WHERE preview_id = $1",
      [wonPreviewId],
    )
    expect(rows.rowCount).toBe(1)
  })

  it("admits exactly two of three concurrent distinct requests at limit 2", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const first = createPreview()
    const previews = [
      first,
      { ...createPreview(), requesterId: first.requesterId },
      { ...createPreview(), requesterId: first.requesterId },
    ]
    previewIds.push(...previews.map((preview) => preview.id))

    const results = await Promise.allSettled(
      previews.map((preview, index) =>
        store.createOrGetWithCapacity({
          requesterId: preview.requesterId,
          idempotencyKey: `request-${index}-${preview.id}`,
          requestFingerprint: `fingerprint-${index}-${preview.id}`,
          preview,
          maxActive: 2,
        }),
      ),
    )
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )

    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: "RATE_LIMITED" })
    await expect(countAdmissions(database, first.requesterId)).resolves.toEqual(
      { active: 2, queued: 2 },
    )
  })

  it("admits different requesters independently at limit 1", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const first = createPreview()
    const second = createPreview()
    previewIds.push(first.id, second.id)

    const results = await Promise.all([
      store.createOrGetWithCapacity({
        requesterId: first.requesterId,
        idempotencyKey: `request-${first.id}`,
        requestFingerprint: `fingerprint-${first.id}`,
        preview: first,
        maxActive: 1,
      }),
      store.createOrGetWithCapacity({
        requesterId: second.requesterId,
        idempotencyKey: `request-${second.id}`,
        requestFingerprint: `fingerprint-${second.id}`,
        preview: second,
        maxActive: 1,
      }),
    ])

    expect(results.every((result) => result.created)).toBe(true)
    await expect(countAdmissions(database, first.requesterId)).resolves.toEqual(
      { active: 1, queued: 1 },
    )
    await expect(
      countAdmissions(database, second.requesterId),
    ).resolves.toEqual({ active: 1, queued: 1 })
  })

  it("rolls back the preview row when queue insertion cannot commit -- no orphan resource is ever left behind", async () => {
    const preview = createPreview()
    previewIds.push(preview.id)
    const store = new PostgresFullStackPreviewStore({
      query: database.query.bind(database),
      ping: database.ping.bind(database),
      close: async () => undefined,
      transaction: (operation) =>
        database.transaction((client) =>
          operation({
            query: async (sql, values) => {
              const result = await client.query(sql, values)
              if (sql.includes("INSERT INTO peephole_fullstack_queue")) {
                throw new Error("simulated transaction failure")
              }
              return result as never
            },
          }),
        ),
    })

    await expect(
      store.createOrGetWithCapacity({
        requesterId: preview.requesterId,
        idempotencyKey: `request-${preview.id}`,
        requestFingerprint: "rollback",
        preview,
        maxActive: 1,
      }),
    ).rejects.toThrow("simulated transaction failure")

    // Neither the resource row nor a queue row survives the crash --
    // proving this phase's core atomicity requirement directly, not just
    // asserting it in prose.
    expect(await store.get(preview.id)).toBeNull()
    expect(
      (
        await database.query(
          "SELECT preview_id FROM peephole_fullstack_queue WHERE preview_id = $1",
          [preview.id],
        )
      ).rowCount,
    ).toBe(0)
  })

  it("nullable child ids round-trip correctly through update()", async () => {
    const store = new PostgresFullStackPreviewStore(database)
    const jobStore = new PostgresPreviewJobStore(database)
    const artifactStore = new PostgresProductionArtifactStore(database)
    const preview = createPreview()
    previewIds.push(preview.id)
    await store.createOrGetWithCapacity({
      requesterId: preview.requesterId,
      idempotencyKey: `request-${preview.id}`,
      requestFingerprint: `fingerprint-${preview.id}`,
      preview,
      maxActive: 1,
    })

    const job = createJob()
    jobIds.push(job.id)
    await jobStore.createOrGet({
      requesterId: job.requesterId,
      idempotencyKey: `request-${job.id}`,
      requestFingerprint: `fingerprint-${job.id}`,
      job,
    })
    const artifactId = `artifact-${randomUUID()}`
    artifactIds.push(artifactId)
    await artifactStore.upsertMaxExpiry(
      artifactId,
      new Date(Date.now() + 60_000),
    )
    const fakeRuntimeId = randomUUID()
    const updated = await store.update(preview.id, (current) => ({
      ...current,
      frontendJobId: job.id,
      artifactId,
      backendRuntimeId: fakeRuntimeId,
    }))
    expect(updated.frontendJobId).toBe(job.id)
    expect(updated.artifactId).toBe(artifactId)
    expect(updated.backendRuntimeId).toBe(fakeRuntimeId)

    const reread = await store.get(preview.id)
    expect(reread?.frontendJobId).toBe(job.id)
    expect(reread?.artifactId).toBe(artifactId)
    expect(reread?.backendRuntimeId).toBe(fakeRuntimeId)

    // ... and back to null again.
    const cleared = await store.update(preview.id, (current) => ({
      ...current,
      frontendJobId: null,
      artifactId: null,
      backendRuntimeId: null,
    }))
    expect(cleared.frontendJobId).toBeNull()
    expect(cleared.artifactId).toBeNull()
    expect(cleared.backendRuntimeId).toBeNull()
  })

  it("deleting a referenced PreviewJob/artifact sets the full-stack preview's pointers to NULL instead of blocking the delete or cascading", async () => {
    const jobStore = new PostgresPreviewJobStore(database)
    const artifactStore = new PostgresProductionArtifactStore(database)
    const previewStore = new PostgresFullStackPreviewStore(database)

    const job = createJob()
    jobIds.push(job.id)
    await jobStore.createOrGet({
      requesterId: job.requesterId,
      idempotencyKey: `request-${job.id}`,
      requestFingerprint: "fk-test",
      job,
    })

    const artifactId = `artifact-${randomUUID()}`
    artifactIds.push(artifactId)
    await artifactStore.upsertMaxExpiry(
      artifactId,
      new Date(Date.now() + 60_000),
    )

    const preview = createPreview()
    previewIds.push(preview.id)
    await previewStore.createOrGetWithCapacity({
      requesterId: preview.requesterId,
      idempotencyKey: `request-${preview.id}`,
      requestFingerprint: `fingerprint-${preview.id}`,
      preview,
      maxActive: 1,
    })
    await previewStore.update(preview.id, (current) => ({
      ...current,
      frontendJobId: job.id,
      artifactId,
    }))
    expect((await previewStore.get(preview.id))?.frontendJobId).toBe(job.id)
    expect((await previewStore.get(preview.id))?.artifactId).toBe(artifactId)

    // The normal production artifact reaper's own delete path -- must
    // never be blocked by this full-stack preview's own reference.
    await expect(
      database.query(
        "DELETE FROM peephole_production_artifacts WHERE artifact_id = $1",
        [artifactId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      database.query("DELETE FROM peephole_preview_jobs WHERE id = $1", [
        job.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })

    // The full-stack preview row itself survives (SET NULL, not CASCADE),
    // with both pointers cleared.
    const afterDelete = await previewStore.get(preview.id)
    expect(afterDelete).not.toBeNull()
    expect(afterDelete?.frontendJobId).toBeNull()
    expect(afterDelete?.artifactId).toBeNull()
  })

  it("applyPostgresMigrations is safe to run again against an already-migrated database", async () => {
    const preview = createPreview()
    previewIds.push(preview.id)
    const store = new PostgresFullStackPreviewStore(database)
    await store.createOrGetWithCapacity({
      requesterId: preview.requesterId,
      idempotencyKey: `request-${preview.id}`,
      requestFingerprint: `fingerprint-${preview.id}`,
      preview,
      maxActive: 1,
    })

    await expect(applyPostgresMigrations(database)).resolves.toBeUndefined()
    await expect(applyPostgresMigrations(database)).resolves.toBeUndefined()

    expect(await store.get(preview.id)).not.toBeNull()
  })
})

function repositoryFixture() {
  return {
    repositoryId: Math.floor(Math.random() * 1_000_000_000) + 1,
    owner: "peephole-integration",
    name: "fullstack-fixture",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  }
}

async function countAdmissions(
  database: PgPoolDatabase,
  requesterId: string,
): Promise<{ active: number; queued: number }> {
  const result = await database.query<{
    active_count: string
    queue_count: string
  }>(
    `
      SELECT
        (
          SELECT count(*)
          FROM peephole_fullstack_previews
          WHERE requester_id = $1
            AND status IN (
              'queued', 'building_frontend', 'starting_backend',
              'awaiting_activation', 'ready', 'stopping'
            )
        )::text AS active_count,
        (
          SELECT count(*)
          FROM peephole_fullstack_queue AS queue
          INNER JOIN peephole_fullstack_previews AS preview
            ON preview.id = queue.preview_id
          WHERE preview.requester_id = $1
        )::text AS queue_count
    `,
    [requesterId],
  )
  return {
    active: Number(result.rows[0]?.active_count ?? "0"),
    queued: Number(result.rows[0]?.queue_count ?? "0"),
  }
}

function createPreview(): StoredFullStackPreview {
  const id = createFullStackPreviewId()
  const now = new Date()
  return {
    id,
    requesterId: `integration-${id}`,
    requestFingerprint: `fingerprint-${id}`,
    repository: repositoryFixture(),
    frontendSourceRoot: "frontend",
    backendSourceRoot: "backend",
    status: "queued",
    url: null,
    frontendJobId: null,
    artifactId: null,
    backendRuntimeId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  }
}

function createJob(): StoredPreviewJob {
  const id = randomUUID()
  const now = new Date()
  const repository = repositoryFixture()
  return {
    id,
    requesterId: `integration-job-${id}`,
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
