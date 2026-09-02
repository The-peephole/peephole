import type { QueryResultRow } from "pg"

import type { PreviewJobStore, StoredPreviewJob } from "../ports"
import { PreviewControlError } from "../errors"
import type { PostgresDatabase, SqlExecutor } from "./database"

interface PreviewJobRow extends QueryResultRow {
  id: string
  requester_id: string
  idempotency_key: string
  request_fingerprint: string
  repository: StoredPreviewJob["repository"]
  plan: StoredPreviewJob["plan"]
  cache_key: string
  cache_status: StoredPreviewJob["cacheStatus"]
  status: StoredPreviewJob["status"]
  artifact: StoredPreviewJob["artifact"]
  error_code: StoredPreviewJob["errorCode"]
  error_message: string | null
  created_at: Date | string
  updated_at: Date | string
  expires_at: Date | string
}

const SELECT_JOB = `
  SELECT id, requester_id, idempotency_key, request_fingerprint,
         repository, plan, cache_key, cache_status, status, artifact,
         error_code, error_message, created_at, updated_at, expires_at
  FROM peephole_preview_jobs
`

export class PostgresPreviewJobStore implements PreviewJobStore {
  constructor(private readonly database: PostgresDatabase) {}

  async get(jobId: string): Promise<StoredPreviewJob | null> {
    const result = await this.database.query<PreviewJobRow>(
      `${SELECT_JOB} WHERE id = $1`,
      [jobId],
    )
    return result.rows[0] ? toStoredJob(result.rows[0]) : null
  }

  async getByIdempotencyKey(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{
    requestFingerprint: string
    job: StoredPreviewJob
  } | null> {
    const result = await this.database.query<PreviewJobRow>(
      `${SELECT_JOB} WHERE requester_id = $1 AND idempotency_key = $2`,
      [requesterId, idempotencyKey],
    )
    const row = result.rows[0]

    return row
      ? { requestFingerprint: row.request_fingerprint, job: toStoredJob(row) }
      : null
  }

  async createOrGet(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    job: StoredPreviewJob
  }): Promise<{ created: boolean; job: StoredPreviewJob }> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<PreviewJobRow>(
        `
          INSERT INTO peephole_preview_jobs (
            id, requester_id, idempotency_key, request_fingerprint,
            repository, plan, cache_key, cache_status, status, artifact,
            error_code, error_message, created_at, updated_at, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9,
            $10::jsonb, $11, $12, $13, $14, $15
          )
          ON CONFLICT (requester_id, idempotency_key) DO NOTHING
          RETURNING *
        `,
        jobValues(input),
      )
      const insertedRow = inserted.rows[0]

      if (insertedRow) {
        return { created: true, job: toStoredJob(insertedRow) }
      }

      const existing = await client.query<PreviewJobRow>(
        `${SELECT_JOB} WHERE requester_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.requesterId, input.idempotencyKey],
      )
      const existingRow = existing.rows[0]

      if (!existingRow) {
        throw new PreviewControlError(
          "INTERNAL_ERROR",
          "Preview job persistence is inconsistent.",
          500,
        )
      }

      if (existingRow.request_fingerprint !== input.requestFingerprint) {
        throw new PreviewControlError(
          "CONFLICT",
          "The idempotency key was already used for a different request.",
          409,
        )
      }

      return { created: false, job: toStoredJob(existingRow) }
    })
  }

  async update(
    jobId: string,
    update: (current: StoredPreviewJob) => StoredPreviewJob,
  ): Promise<StoredPreviewJob> {
    return this.database.transaction(async (client) => {
      const selected = await client.query<PreviewJobRow>(
        `${SELECT_JOB} WHERE id = $1 FOR UPDATE`,
        [jobId],
      )
      const current = selected.rows[0]

      if (!current) {
        throw new PreviewControlError(
          "NOT_FOUND",
          "Preview job not found.",
          404,
        )
      }

      const next = update(toStoredJob(current))
      assertImmutableIdentity(current, next)
      return persistUpdate(client, next)
    })
  }
}

async function persistUpdate(
  client: SqlExecutor,
  job: StoredPreviewJob,
): Promise<StoredPreviewJob> {
  const result = await client.query<PreviewJobRow>(
    `
      UPDATE peephole_preview_jobs
      SET repository = $2::jsonb,
          plan = $3::jsonb,
          cache_key = $4,
          cache_status = $5,
          status = $6,
          artifact = $7::jsonb,
          error_code = $8,
          error_message = $9,
          updated_at = $10,
          expires_at = $11
      WHERE id = $1
      RETURNING *
    `,
    [
      job.id,
      JSON.stringify(job.repository),
      JSON.stringify(job.plan),
      job.cacheKey,
      job.cacheStatus,
      job.status,
      job.artifact ? JSON.stringify(job.artifact) : null,
      job.errorCode,
      job.errorMessage,
      job.updatedAt,
      job.expiresAt,
    ],
  )
  const row = result.rows[0]

  if (!row) {
    throw new PreviewControlError(
      "INTERNAL_ERROR",
      "Preview job update was not persisted.",
      500,
    )
  }

  return toStoredJob(row)
}

function jobValues(input: {
  requesterId: string
  idempotencyKey: string
  requestFingerprint: string
  job: StoredPreviewJob
}): readonly unknown[] {
  const { job } = input
  return [
    job.id,
    input.requesterId,
    input.idempotencyKey,
    input.requestFingerprint,
    JSON.stringify(job.repository),
    JSON.stringify(job.plan),
    job.cacheKey,
    job.cacheStatus,
    job.status,
    job.artifact ? JSON.stringify(job.artifact) : null,
    job.errorCode,
    job.errorMessage,
    job.createdAt,
    job.updatedAt,
    job.expiresAt,
  ]
}

function assertImmutableIdentity(
  current: PreviewJobRow,
  next: StoredPreviewJob,
): void {
  if (current.id !== next.id || current.requester_id !== next.requesterId) {
    throw new PreviewControlError(
      "INTERNAL_ERROR",
      "Preview job identity cannot be changed.",
      500,
    )
  }
}

function toStoredJob(row: PreviewJobRow): StoredPreviewJob {
  return structuredClone({
    id: row.id,
    requesterId: row.requester_id,
    repository: row.repository,
    plan: row.plan,
    cacheKey: row.cache_key,
    cacheStatus: row.cache_status,
    status: row.status,
    artifact: row.artifact,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    expiresAt: toIsoString(row.expires_at),
  })
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}
