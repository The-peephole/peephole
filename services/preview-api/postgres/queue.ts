import type { QueryResultRow } from "pg"

import type { QueuedPreviewJob } from "../../../types/preview"
import type {
  PreviewQueue,
  PreviewQueueConsumer,
  PreviewQueueLease,
} from "../ports"
import type { PostgresDatabase } from "./database"

interface QueueRow extends QueryResultRow {
  payload: QueuedPreviewJob
  attempts: number
}

export class PostgresPreviewQueue
  implements PreviewQueue, PreviewQueueConsumer
{
  constructor(private readonly database: PostgresDatabase) {}

  async enqueue(job: QueuedPreviewJob): Promise<void> {
    await this.database.query(
      `
        INSERT INTO peephole_preview_queue (
          job_id, payload, status, available_at, attempts, created_at, updated_at
        ) VALUES ($1, $2::jsonb, 'queued', now(), 0, now(), now())
        ON CONFLICT (job_id) DO NOTHING
      `,
      [job.jobId, JSON.stringify(job)],
    )
  }

  async cancel(jobId: string): Promise<void> {
    await this.database.query(
      `
        UPDATE peephole_preview_queue
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE job_id = $1 AND status <> 'cancelled'
      `,
      [jobId],
    )
  }

  async lease(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<PreviewQueueLease | null> {
    validateWorkerLease(workerId, leaseMs)
    const leaseExpiresAt = new Date(now.getTime() + leaseMs)
    const result = await this.database.query<QueueRow>(
      `
        WITH candidate AS (
          SELECT job_id
          FROM peephole_preview_queue
          WHERE (
            status = 'queued' AND available_at <= $2
          ) OR (
            status = 'leased' AND lease_expires_at <= $2
          )
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE peephole_preview_queue AS queue
        SET status = 'leased',
            lease_owner = $1,
            lease_expires_at = $3,
            attempts = queue.attempts + 1,
            updated_at = $2
        FROM candidate
        WHERE queue.job_id = candidate.job_id
        RETURNING queue.payload, queue.attempts
      `,
      [workerId, now, leaseExpiresAt],
    )
    const row = result.rows[0]

    return row
      ? { job: structuredClone(row.payload), attempts: row.attempts }
      : null
  }

  async acknowledge(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.database.query(
      `
        DELETE FROM peephole_preview_queue
        WHERE job_id = $1 AND status = 'leased' AND lease_owner = $2
      `,
      [jobId, workerId],
    )
    return result.rowCount === 1
  }

  async release(
    jobId: string,
    workerId: string,
    availableAt: Date,
  ): Promise<boolean> {
    const result = await this.database.query(
      `
        UPDATE peephole_preview_queue
        SET status = 'queued',
            available_at = $3,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE job_id = $1 AND status = 'leased' AND lease_owner = $2
      `,
      [jobId, workerId, availableAt],
    )
    return result.rowCount === 1
  }
}

function validateWorkerLease(workerId: string, leaseMs: number): void {
  if (!/^[a-z\d][a-z\d._-]{0,127}$/i.test(workerId)) {
    throw new Error("Preview worker id is invalid.")
  }

  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) {
    throw new Error("Preview queue lease must be between 1 and 900 seconds.")
  }
}
