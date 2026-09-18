import type { QueryResultRow } from "pg"

import type { PostgresDatabase } from "../../preview-api/postgres/database"
import type {
  FullStackPreviewQueue,
  FullStackPreviewQueueConsumer,
  FullStackPreviewQueueLease,
} from "../ports"
import type { QueuedFullStackPreview } from "../../../types/fullstackPreview"

interface QueueRow extends QueryResultRow {
  payload: QueuedFullStackPreview
  attempts: number
}

/** Modeled directly on `PostgresPreviewQueue`
 * (services/preview-api/postgres/queue.ts) -- same lease/attempt/
 * `SKIP LOCKED` shape, applied to `peephole_fullstack_queue` instead of
 * inventing a second queue system. */
export class PostgresFullStackPreviewQueue
  implements FullStackPreviewQueue, FullStackPreviewQueueConsumer
{
  constructor(private readonly database: PostgresDatabase) {}

  async enqueue(preview: QueuedFullStackPreview): Promise<void> {
    await this.database.query(
      `
        INSERT INTO peephole_fullstack_queue (
          preview_id, payload, status, available_at, attempts, created_at, updated_at
        ) VALUES ($1, $2::jsonb, 'queued', now(), 0, now(), now())
        ON CONFLICT (preview_id) DO NOTHING
      `,
      [preview.previewId, JSON.stringify(preview)],
    )
  }

  async cancel(previewId: string): Promise<void> {
    await this.database.query(
      `
        UPDATE peephole_fullstack_queue
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE preview_id = $1 AND status <> 'cancelled'
      `,
      [previewId],
    )
  }

  async lease(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<FullStackPreviewQueueLease | null> {
    validateWorkerLease(workerId, leaseMs)
    const result = await this.database.query<QueueRow>(
      `
        WITH lease_clock AS (
          SELECT GREATEST($2::timestamptz, clock_timestamp()) AS lease_now
        ), candidate AS (
          SELECT queue.preview_id, lease_clock.lease_now
          FROM peephole_fullstack_queue AS queue
          CROSS JOIN lease_clock
          WHERE (
            queue.status = 'queued'
            AND queue.available_at <= lease_clock.lease_now
          ) OR (
            queue.status = 'leased'
            AND queue.lease_expires_at <= lease_clock.lease_now
          )
          ORDER BY queue.available_at ASC, queue.created_at ASC
          FOR UPDATE OF queue SKIP LOCKED
          LIMIT 1
        )
        UPDATE peephole_fullstack_queue AS queue
        SET status = 'leased',
            lease_owner = $1,
            lease_expires_at = candidate.lease_now
              + ($3::double precision * interval '1 millisecond'),
            attempts = queue.attempts + 1,
            updated_at = candidate.lease_now
        FROM candidate
        WHERE queue.preview_id = candidate.preview_id
        RETURNING queue.payload, queue.attempts
      `,
      [workerId, now, leaseMs],
    )
    const row = result.rows[0]

    return row
      ? { preview: structuredClone(row.payload), attempts: row.attempts }
      : null
  }

  async acknowledge(
    previewId: string,
    workerId: string,
    attempt: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `
        DELETE FROM peephole_fullstack_queue
        WHERE preview_id = $1 AND status = 'leased' AND lease_owner = $2 AND attempts = $3
      `,
      [previewId, workerId, attempt],
    )
    return result.rowCount === 1
  }

  async release(
    previewId: string,
    workerId: string,
    availableAt: Date,
    attempt: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `
        UPDATE peephole_fullstack_queue
        SET status = 'queued',
            available_at = $3,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE preview_id = $1 AND status = 'leased' AND lease_owner = $2 AND attempts = $4
      `,
      [previewId, workerId, availableAt, attempt],
    )
    return result.rowCount === 1
  }

  async renew(
    previewId: string,
    workerId: string,
    attempt: number,
    leaseMs: number,
  ): Promise<boolean> {
    validateWorkerLease(workerId, leaseMs)
    const result = await this.database.query(
      `
        UPDATE peephole_fullstack_queue
        SET lease_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'), updated_at = clock_timestamp()
        WHERE preview_id = $1 AND status = 'leased' AND lease_owner = $2 AND attempts = $3
          AND lease_expires_at > clock_timestamp()
      `,
      [previewId, workerId, attempt, leaseMs],
    )
    return result.rowCount === 1
  }
}

function validateWorkerLease(workerId: string, leaseMs: number): void {
  if (!/^[a-z\d][a-z\d._-]{0,127}$/i.test(workerId)) {
    throw new Error("Full-stack preview worker id is invalid.")
  }

  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) {
    throw new Error(
      "Full-stack preview queue lease must be between 1 and 900 seconds.",
    )
  }
}
