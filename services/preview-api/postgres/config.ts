import type { PoolConfig } from "pg"

export interface PostgresConfig {
  pool: PoolConfig
}

export function readPostgresConfig(
  environment: NodeJS.ProcessEnv,
): PostgresConfig {
  const connectionString = environment.PEEPHOLE_DATABASE_URL?.trim()

  if (!connectionString) {
    throw new Error("PEEPHOLE_DATABASE_URL is required.")
  }

  let url: URL

  try {
    url = new URL(connectionString)
  } catch {
    throw new Error("PEEPHOLE_DATABASE_URL must be a valid PostgreSQL URL.")
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      "PEEPHOLE_DATABASE_URL must use postgres:// or postgresql://.",
    )
  }

  if (url.searchParams.has("sslmode")) {
    throw new Error(
      "Configure database TLS through PEEPHOLE_DATABASE_SSL_CA, not sslmode URL parameters.",
    )
  }

  const isLocal = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)
  const certificateAuthority = environment.PEEPHOLE_DATABASE_SSL_CA

  return {
    pool: {
      connectionString,
      max: readPoolSize(environment.PEEPHOLE_DATABASE_POOL_SIZE),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ssl: isLocal
        ? false
        : {
            rejectUnauthorized: true,
            ...(certificateAuthority ? { ca: certificateAuthority } : {}),
          },
    },
  }
}

function readPoolSize(value: string | undefined): number {
  if (!value) {
    return 10
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("PEEPHOLE_DATABASE_POOL_SIZE must be an integer.")
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("PEEPHOLE_DATABASE_POOL_SIZE must be between 1 and 50.")
  }

  return parsed
}
