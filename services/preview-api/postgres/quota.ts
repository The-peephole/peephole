import type { QueryResultRow } from "pg"

import type {
  PreviewRequester,
  PreviewRepositoryRef,
} from "../../../types/preview"
import type { PreviewQuota } from "../ports"
import type { PostgresDatabase } from "./database"

interface QuotaRow extends QueryResultRow {
  request_count: number
}

export interface PostgresPreviewQuotaOptions {
  windowMs?: number
  perUser?: number
  perIp?: number
  perUserRepository?: number
}

export class PostgresPreviewQuota implements PreviewQuota {
  private readonly windowMs: number
  private readonly perUser: number
  private readonly perIp: number
  private readonly perUserRepository: number

  constructor(
    private readonly database: PostgresDatabase,
    options: PostgresPreviewQuotaOptions = {},
  ) {
    this.windowMs = validateLimit("windowMs", options.windowMs ?? 60_000)
    this.perUser = validateLimit("perUser", options.perUser ?? 10)
    this.perIp = validateLimit("perIp", options.perIp ?? 30)
    this.perUserRepository = validateLimit(
      "perUserRepository",
      options.perUserRepository ?? 5,
    )
  }

  async consume(
    requester: PreviewRequester,
    repository: PreviewRepositoryRef,
    now: Date,
  ): Promise<
    { allowed: true } | { allowed: false; retryAfterSeconds: number }
  > {
    const windowStartMs =
      Math.floor(now.getTime() / this.windowMs) * this.windowMs
    const windowStart = new Date(windowStartMs)
    const scopes: Array<[string, number]> = [
      [await hashScope(`user:${requester.subject}`), this.perUser],
      [await hashScope(`ip:${requester.ip}`), this.perIp],
      [
        await hashScope(
          `repository:${requester.subject}:${repository.repositoryId}`,
        ),
        this.perUserRepository,
      ],
    ]

    try {
      await this.database.transaction(async (client) => {
        for (const [scopeKey, limit] of scopes) {
          const result = await client.query<QuotaRow>(
            `
              INSERT INTO peephole_preview_quota (
                scope_key, window_start, request_count
              ) VALUES ($1, $2, 1)
              ON CONFLICT (scope_key, window_start) DO UPDATE
              SET request_count = peephole_preview_quota.request_count + 1
              RETURNING request_count
            `,
            [scopeKey, windowStart],
          )

          if ((result.rows[0]?.request_count ?? limit + 1) > limit) {
            throw new QuotaExceededError()
          }
        }
      })
      return { allowed: true }
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) {
        throw error
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStartMs + this.windowMs - now.getTime()) / 1_000),
        ),
      }
    }
  }
}

class QuotaExceededError extends Error {}

function validateLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error(`${name} must be a bounded positive integer.`)
  }
  return value
}

async function hashScope(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}
