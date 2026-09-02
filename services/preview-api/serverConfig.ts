export interface PreviewApiServerConfig {
  host: string
  port: number
  maxBodyBytes: number
  requestTimeoutMs: number
}

const DEFAULT_CONFIG: PreviewApiServerConfig = {
  host: "0.0.0.0",
  port: 8_787,
  maxBodyBytes: 16 * 1024,
  requestTimeoutMs: 15_000,
}

export function readPreviewApiServerConfig(
  environment: NodeJS.ProcessEnv,
): PreviewApiServerConfig {
  return {
    host: readHost(environment.PEEPHOLE_API_HOST),
    port: readInteger(
      "PEEPHOLE_API_PORT",
      environment.PEEPHOLE_API_PORT,
      DEFAULT_CONFIG.port,
      1,
      65_535,
    ),
    maxBodyBytes: readInteger(
      "PEEPHOLE_API_MAX_BODY_BYTES",
      environment.PEEPHOLE_API_MAX_BODY_BYTES,
      DEFAULT_CONFIG.maxBodyBytes,
      1,
      1024 * 1024,
    ),
    requestTimeoutMs: readInteger(
      "PEEPHOLE_API_REQUEST_TIMEOUT_MS",
      environment.PEEPHOLE_API_REQUEST_TIMEOUT_MS,
      DEFAULT_CONFIG.requestTimeoutMs,
      1_000,
      60_000,
    ),
  }
}

function readHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_CONFIG.host

  if (host.length > 253 || /\s|[/:]/.test(host)) {
    throw new Error("PEEPHOLE_API_HOST is invalid.")
  }

  return host
}

function readInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer.`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`)
  }

  return parsed
}
