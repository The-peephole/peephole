import type { QueryResultRow } from "pg"

import type {
  PostgresDatabase,
  SqlExecutor,
} from "../../preview-api/postgres/database"
import { FullStackPreviewControlError } from "../errors"
import type { FullStackPreviewStore, StoredFullStackPreview } from "../ports"

interface FullStackPreviewRow extends QueryResultRow {
  id: string
  requester_id: string
  idempotency_key: string
  request_fingerprint: string
  repository: StoredFullStackPreview["repository"]
  frontend_source_root: string
  backend_source_root: string
  status: StoredFullStackPreview["status"]
  url: string | null
  frontend_job_id: string | null
  artifact_id: string | null
  backend_runtime_id: string | null
  error_code: StoredFullStackPreview["errorCode"]
  error_message: string | null
  created_at: Date | string
  updated_at: Date | string
  expires_at: Date | string
}

const SELECT_PREVIEW = `
  SELECT id, requester_id, idempotency_key, request_fingerprint, repository,
         frontend_source_root, backend_source_root, status, url,
         frontend_job_id, artifact_id, backend_runtime_id,
         error_code, error_message, created_at, updated_at, expires_at
  FROM peephole_fullstack_previews
`

const ACTIVE_STATUSES = [
  "queued",
  "building_frontend",
  "starting_backend",
  "ready",
  "stopping",
] as const

/**
 * Mirrors `PostgresPreviewJobStore`'s exact atomic-admission shape
 * (services/preview-api/postgres/jobStore.ts): `createOrGet` inserts the
 * resource row and its initial queue row inside the SAME transaction, or
 * returns the existing idempotent resource -- never two separate
 * INSERT/commit steps, so an API crash between them can never leave a
 * durable preview that no queue delivery will ever pick up. See that
 * file's own doc comments for why this matters.
 */
export class PostgresFullStackPreviewStore implements FullStackPreviewStore {
  constructor(private readonly database: PostgresDatabase) {}

  async get(previewId: string): Promise<StoredFullStackPreview | null> {
    const result = await this.database.query<FullStackPreviewRow>(
      `${SELECT_PREVIEW} WHERE id = $1`,
      [previewId],
    )
    return result.rows[0] ? toStoredPreview(result.rows[0]) : null
  }

  async getByIdempotencyKey(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{
    requestFingerprint: string
    preview: StoredFullStackPreview
  } | null> {
    const result = await this.database.query<FullStackPreviewRow>(
      `${SELECT_PREVIEW} WHERE requester_id = $1 AND idempotency_key = $2`,
      [requesterId, idempotencyKey],
    )
    const row = result.rows[0]
    return row
      ? {
          requestFingerprint: row.request_fingerprint,
          preview: toStoredPreview(row),
        }
      : null
  }

  async countActiveByRequester(requesterId: string): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM peephole_fullstack_previews
        WHERE requester_id = $1 AND status = ANY($2::text[])
      `,
      [requesterId, ACTIVE_STATUSES],
    )
    return Number(result.rows[0]?.count ?? "0")
  }

  async createOrGet(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    preview: StoredFullStackPreview
  }): Promise<{
    created: boolean
    preview: StoredFullStackPreview
    enqueued?: boolean
  }> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<FullStackPreviewRow>(
        `
          INSERT INTO peephole_fullstack_previews (
            id, requester_id, idempotency_key, request_fingerprint,
            repository, frontend_source_root, backend_source_root, status,
            url, frontend_job_id, artifact_id, backend_runtime_id,
            error_code, error_message, created_at, updated_at, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17
          )
          ON CONFLICT (requester_id, idempotency_key) DO NOTHING
          RETURNING *
        `,
        previewValues(input),
      )
      const insertedRow = inserted.rows[0]

      if (insertedRow) {
        const preview = toStoredPreview(insertedRow)
        const enqueued = preview.status === "queued"
        if (enqueued) {
          // Admission and delivery commit together, including after an
          // API crash -- see this class's own doc comment.
          await client.query(
            `
              INSERT INTO peephole_fullstack_queue (
                preview_id, payload, status, available_at, attempts,
                created_at, updated_at
              ) VALUES ($1, $2::jsonb, 'queued', now(), 0, now(), now())
            `,
            [
              preview.id,
              JSON.stringify({
                previewId: preview.id,
                repository: preview.repository,
                frontendSourceRoot: preview.frontendSourceRoot,
                backendSourceRoot: preview.backendSourceRoot,
              }),
            ],
          )
        }
        return { created: true, preview, enqueued }
      }

      const existing = await client.query<FullStackPreviewRow>(
        `${SELECT_PREVIEW} WHERE requester_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.requesterId, input.idempotencyKey],
      )
      const existingRow = existing.rows[0]

      if (!existingRow) {
        throw new FullStackPreviewControlError(
          "INTERNAL_ERROR",
          "Full-stack preview persistence is inconsistent.",
          500,
        )
      }

      if (existingRow.request_fingerprint !== input.requestFingerprint) {
        throw new FullStackPreviewControlError(
          "CONFLICT",
          "The idempotency key was already used for a different request.",
          409,
        )
      }

      return { created: false, preview: toStoredPreview(existingRow) }
    })
  }

  async update(
    previewId: string,
    update: (current: StoredFullStackPreview) => StoredFullStackPreview,
  ): Promise<StoredFullStackPreview> {
    return this.database.transaction(async (client) => {
      const selected = await client.query<FullStackPreviewRow>(
        `${SELECT_PREVIEW} WHERE id = $1 FOR UPDATE`,
        [previewId],
      )
      const current = selected.rows[0]

      if (!current) {
        throw new FullStackPreviewControlError(
          "NOT_FOUND",
          "Full-stack preview not found.",
          404,
        )
      }

      const next = update(toStoredPreview(current))
      assertImmutableIdentity(current, next)
      return persistUpdate(client, next)
    })
  }
}

async function persistUpdate(
  client: SqlExecutor,
  preview: StoredFullStackPreview,
): Promise<StoredFullStackPreview> {
  const result = await client.query<FullStackPreviewRow>(
    `
      UPDATE peephole_fullstack_previews
      SET repository = $2::jsonb,
          frontend_source_root = $3,
          backend_source_root = $4,
          status = $5,
          url = $6,
          frontend_job_id = $7,
          artifact_id = $8,
          backend_runtime_id = $9,
          error_code = $10,
          error_message = $11,
          updated_at = $12,
          expires_at = $13
      WHERE id = $1
      RETURNING *
    `,
    [
      preview.id,
      JSON.stringify(preview.repository),
      preview.frontendSourceRoot,
      preview.backendSourceRoot,
      preview.status,
      preview.url,
      preview.frontendJobId,
      preview.artifactId,
      preview.backendRuntimeId,
      preview.errorCode,
      preview.errorMessage,
      preview.updatedAt,
      preview.expiresAt,
    ],
  )
  const row = result.rows[0]

  if (!row) {
    throw new FullStackPreviewControlError(
      "INTERNAL_ERROR",
      "Full-stack preview update was not persisted.",
      500,
    )
  }

  return toStoredPreview(row)
}

function previewValues(input: {
  requesterId: string
  idempotencyKey: string
  requestFingerprint: string
  preview: StoredFullStackPreview
}): readonly unknown[] {
  const { preview } = input
  return [
    preview.id,
    input.requesterId,
    input.idempotencyKey,
    input.requestFingerprint,
    JSON.stringify(preview.repository),
    preview.frontendSourceRoot,
    preview.backendSourceRoot,
    preview.status,
    preview.url,
    preview.frontendJobId,
    preview.artifactId,
    preview.backendRuntimeId,
    preview.errorCode,
    preview.errorMessage,
    preview.createdAt,
    preview.updatedAt,
    preview.expiresAt,
  ]
}

function assertImmutableIdentity(
  current: FullStackPreviewRow,
  next: StoredFullStackPreview,
): void {
  if (current.id !== next.id || current.requester_id !== next.requesterId) {
    throw new FullStackPreviewControlError(
      "INTERNAL_ERROR",
      "Full-stack preview identity cannot be changed.",
      500,
    )
  }
}

function toStoredPreview(row: FullStackPreviewRow): StoredFullStackPreview {
  return structuredClone({
    id: row.id,
    requesterId: row.requester_id,
    requestFingerprint: row.request_fingerprint,
    repository: row.repository,
    frontendSourceRoot: row.frontend_source_root,
    backendSourceRoot: row.backend_source_root,
    status: row.status,
    url: row.url,
    frontendJobId: row.frontend_job_id,
    artifactId: row.artifact_id,
    backendRuntimeId: row.backend_runtime_id,
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
