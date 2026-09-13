import { randomUUID } from "node:crypto"

import {
  PreviewApiClient,
  PreviewApiError,
  type PreviewApi,
} from "../../core/preview/apiClient"
import {
  isTrustedPreviewArtifactUrl,
  parsePreviewApiBaseUrl,
  parsePreviewArtifactBaseDomain,
} from "../../core/preview/config"
import type { PreviewJob } from "../../types/preview"
import {
  PRODUCTION_SMOKE_ARTIFACT_MARKER,
  PRODUCTION_SMOKE_REQUEST,
} from "./fixture"

const HEALTH_RESPONSE_LIMIT_BYTES = 64 * 1024
const CACHE_SETTLE_MS = 1_000
const ACTIVE_STATUSES = new Set([
  "queued",
  "fetching",
  "installing",
  "building",
  "publishing",
])
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled", "expired"])

export interface ApiSmokeConfig {
  apiBaseUrl: string
  artifactBaseDomain: string
  sessionToken: string
  sessionExpiresAt: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
  artifactMaxBytes: number
}

export interface ApiSmokeResult {
  firstJob: PreviewJob
  cachedJob: PreviewJob
}

export interface PollOptions {
  timeoutMs: number
  intervalMs: number
  requestTimeoutMs: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export type SmokeReporter = (check: string, detail?: string) => void

export interface ApiSmokeDependencies {
  fetch?: typeof globalThis.fetch
  api?: PreviewApi
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  randomId?: () => string
  report?: SmokeReporter
}

export class ProductionSmokeError extends Error {
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(message)
    this.name = "ProductionSmokeError"
  }
}

export function readApiSmokeConfig(
  environment: NodeJS.ProcessEnv,
  now = Date.now(),
): ApiSmokeConfig {
  const parsedBaseUrl = parsePreviewApiBaseUrl(
    environment.PEEPHOLE_SMOKE_API_BASE_URL,
  )
  if (!parsedBaseUrl) {
    throw new ProductionSmokeError(
      "configuration",
      "PEEPHOLE_SMOKE_API_BASE_URL is required.",
    )
  }
  const apiUrl = new URL(parsedBaseUrl)
  if (apiUrl.protocol !== "https:" || apiUrl.pathname !== "/") {
    throw new ProductionSmokeError(
      "configuration",
      "PEEPHOLE_SMOKE_API_BASE_URL must be an HTTPS origin without a path.",
    )
  }

  let artifactBaseDomain: string | null
  try {
    artifactBaseDomain = parsePreviewArtifactBaseDomain(
      environment.PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN,
    )
  } catch {
    throw new ProductionSmokeError(
      "configuration",
      "PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN is invalid.",
    )
  }
  if (!artifactBaseDomain) {
    throw new ProductionSmokeError(
      "configuration",
      "PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN is required.",
    )
  }

  const pollIntervalMs = readInteger(
    "PEEPHOLE_SMOKE_POLL_INTERVAL_MS",
    environment.PEEPHOLE_SMOKE_POLL_INTERVAL_MS,
    2_000,
    250,
    10_000,
  )
  const pollTimeoutMs = readInteger(
    "PEEPHOLE_SMOKE_POLL_TIMEOUT_MS",
    environment.PEEPHOLE_SMOKE_POLL_TIMEOUT_MS,
    10 * 60_000,
    30_000,
    15 * 60_000,
  )
  const requestTimeoutMs = readInteger(
    "PEEPHOLE_SMOKE_REQUEST_TIMEOUT_MS",
    environment.PEEPHOLE_SMOKE_REQUEST_TIMEOUT_MS,
    15_000,
    1_000,
    60_000,
  )
  const artifactMaxBytes = readInteger(
    "PEEPHOLE_SMOKE_ARTIFACT_MAX_BYTES",
    environment.PEEPHOLE_SMOKE_ARTIFACT_MAX_BYTES,
    1024 * 1024,
    16 * 1024,
    4 * 1024 * 1024,
  )

  const sessionToken = environment.PEEPHOLE_SMOKE_SESSION_TOKEN?.trim()
  if (!sessionToken || sessionToken.length > 4_096) {
    throw new ProductionSmokeError(
      "authentication",
      "A bounded PEEPHOLE_SMOKE_SESSION_TOKEN is required.",
    )
  }
  const tokenParts = sessionToken.split(".")
  if (
    tokenParts.length !== 3 ||
    tokenParts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)) ||
    !/^\d+$/.test(tokenParts[1] ?? "")
  ) {
    throw new ProductionSmokeError(
      "authentication",
      "PEEPHOLE_SMOKE_SESSION_TOKEN is not a Peephole session token.",
    )
  }
  const expiresAtMs = Number(tokenParts[1]) * 1_000
  const expiresAt = new Date(expiresAtMs)
  const requiredSessionLifetimeMs =
    pollTimeoutMs + 2 * requestTimeoutMs + CACHE_SETTLE_MS
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAtMs <= now + requiredSessionLifetimeMs
  ) {
    throw new ProductionSmokeError(
      "authentication",
      "The Peephole session cannot remain valid for the bounded smoke window; reconnect GitHub.",
    )
  }

  return {
    apiBaseUrl: parsedBaseUrl,
    artifactBaseDomain,
    sessionToken,
    sessionExpiresAt: expiresAt.toISOString(),
    pollIntervalMs,
    pollTimeoutMs,
    requestTimeoutMs,
    artifactMaxBytes,
  }
}

export async function runProductionApiSmoke(
  config: ApiSmokeConfig,
  dependencies: ApiSmokeDependencies = {},
): Promise<ApiSmokeResult> {
  const fetch = dependencies.fetch ?? globalThis.fetch
  const report = dependencies.report ?? (() => undefined)
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? delay
  const randomId = dependencies.randomId ?? randomUUID

  await verifyServiceEndpoints(
    config.apiBaseUrl,
    fetch,
    config.requestTimeoutMs,
    "public",
    report,
  )
  report(
    "fixture pin",
    `${PRODUCTION_SMOKE_REQUEST.repository.owner}/${PRODUCTION_SMOKE_REQUEST.repository.name}@${PRODUCTION_SMOKE_REQUEST.repository.commitSha}`,
  )

  const api =
    dependencies.api ??
    new PreviewApiClient(config.apiBaseUrl, {
      fetch,
      getSession: () => ({
        token: config.sessionToken,
        expiresAt: config.sessionExpiresAt,
      }),
    })

  const firstJob = await createJob(
    api,
    `smoke-${randomId()}`,
    config.requestTimeoutMs,
  )
  assertFixtureJob(firstJob)
  report(
    "fixture identity",
    "server returned the exact repository and build plan",
  )
  report("preview job accepted", `job ${firstJob.id}`)

  const readyJob = await pollPreviewJob(api, firstJob, {
    timeoutMs: config.pollTimeoutMs,
    intervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    now,
    sleep,
  })
  assertReadyJob(readyJob, config.artifactBaseDomain, now())
  report(
    "job ready",
    `job ${readyJob.id}; initial cache ${readyJob.cacheStatus}`,
  )

  await validateArtifact(
    readyJob.artifact!.url,
    config.artifactBaseDomain,
    fetch,
    {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.artifactMaxBytes,
      expectedMarker: PRODUCTION_SMOKE_ARTIFACT_MARKER,
    },
  )
  report("artifact", "trusted HTTPS HTML returned HTTP 200")

  await sleep(CACHE_SETTLE_MS)
  const cachedJob = await createJob(
    api,
    `smoke-${randomId()}`,
    config.requestTimeoutMs,
  )
  assertFixtureJob(cachedJob)
  assertReadyJob(cachedJob, config.artifactBaseDomain, now())
  if (
    cachedJob.cacheStatus !== "hit" ||
    cachedJob.cacheKey !== readyJob.cacheKey ||
    cachedJob.artifact?.url !== readyJob.artifact?.url
  ) {
    throw new ProductionSmokeError(
      "cache response",
      "The follow-up request did not return the same ready cached artifact.",
    )
  }
  report("cache response", `job ${cachedJob.id}; hit and ready`)

  return { firstJob: readyJob, cachedJob }
}

export async function verifyServiceEndpoints(
  baseUrl: string,
  fetch: typeof globalThis.fetch,
  timeoutMs: number,
  labelPrefix: "public" | "local",
  report: SmokeReporter = () => undefined,
): Promise<void> {
  await verifyJsonEndpoint(
    new URL("healthz", baseUrl),
    fetch,
    timeoutMs,
    `${labelPrefix} health`,
    (body) => isObject(body) && body.ok === true,
  )
  report(`${labelPrefix} health`, "HTTP 200")
  await verifyJsonEndpoint(
    new URL("readyz", baseUrl),
    fetch,
    timeoutMs,
    `${labelPrefix} readiness`,
    (body) => isObject(body) && body.ready === true,
  )
  report(`${labelPrefix} readiness`, "HTTP 200")
}

export async function pollPreviewJob(
  api: PreviewApi,
  initialJob: PreviewJob,
  options: PollOptions,
): Promise<PreviewJob> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const deadline = now() + options.timeoutMs
  let job = initialJob

  for (;;) {
    assertFixtureJob(job)
    if (job.status === "ready") return job
    if (TERMINAL_FAILURE_STATUSES.has(job.status)) {
      throw new ProductionSmokeError(
        "job ready",
        `Job ${job.id} reached ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}.`,
      )
    }
    if (!ACTIVE_STATUSES.has(job.status)) {
      throw new ProductionSmokeError(
        "job polling",
        `Job ${job.id} returned unexpected status ${job.status}.`,
      )
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new ProductionSmokeError(
        "job polling",
        `Job ${job.id} did not reach ready within ${String(options.timeoutMs)}ms.`,
      )
    }
    await sleep(Math.min(options.intervalMs, remaining))
    try {
      job = await api.get(job.id, {
        signal: AbortSignal.timeout(
          Math.min(options.requestTimeoutMs, Math.max(1, deadline - now())),
        ),
      })
    } catch (error) {
      throw apiFailure("job polling", error)
    }
  }
}

export function assertReadyJob(
  job: PreviewJob,
  artifactBaseDomain: string,
  now = Date.now(),
): void {
  if (
    job.status !== "ready" ||
    job.errorCode !== null ||
    job.errorMessage !== null ||
    !job.artifact
  ) {
    throw new ProductionSmokeError(
      "job ready",
      `Job ${job.id} is not a clean ready result.`,
    )
  }
  if (!isTrustedPreviewArtifactUrl(job.artifact.url, artifactBaseDomain)) {
    throw new ProductionSmokeError(
      "artifact URL",
      "The ready job returned an untrusted artifact URL.",
    )
  }
  if (new URL(job.artifact.url).protocol !== "https:") {
    throw new ProductionSmokeError(
      "artifact URL",
      "The production artifact URL must use HTTPS.",
    )
  }
  const expiresAt = Date.parse(job.artifact.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new ProductionSmokeError(
      "artifact URL",
      "The production artifact reference is already expired.",
    )
  }
}

export async function validateArtifact(
  artifactUrl: string,
  artifactBaseDomain: string,
  fetch: typeof globalThis.fetch,
  options: {
    timeoutMs: number
    maxBytes: number
    expectedMarker: string
  },
): Promise<void> {
  if (!isTrustedPreviewArtifactUrl(artifactUrl, artifactBaseDomain)) {
    throw new ProductionSmokeError(
      "artifact URL",
      "Refusing to fetch an artifact outside the configured production domain.",
    )
  }

  let response: Response
  try {
    response = await fetch(artifactUrl, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch {
    throw new ProductionSmokeError(
      "artifact",
      "The trusted artifact could not be reached.",
    )
  }
  if (response.status !== 200) {
    throw new ProductionSmokeError(
      "artifact",
      `Expected HTTP 200 without redirects, received ${String(response.status)}.`,
    )
  }
  const contentType = response.headers.get("content-type")
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
    throw new ProductionSmokeError(
      "artifact",
      "The artifact Content-Type is not text/html.",
    )
  }
  const body = await readBoundedText(response, options.maxBytes, "artifact")
  if (!body.includes(options.expectedMarker)) {
    throw new ProductionSmokeError(
      "artifact",
      "The artifact HTML does not contain the pinned fixture marker.",
    )
  }
}

async function createJob(
  api: PreviewApi,
  idempotencyKey: string,
  requestTimeoutMs: number,
): Promise<PreviewJob> {
  try {
    return await api.create(PRODUCTION_SMOKE_REQUEST, {
      idempotencyKey,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (error) {
    throw apiFailure("preview job creation", error)
  }
}

function assertFixtureJob(job: PreviewJob): void {
  const expected = PRODUCTION_SMOKE_REQUEST.repository
  if (
    job.repository.repositoryId !== expected.repositoryId ||
    job.repository.owner.toLowerCase() !== expected.owner.toLowerCase() ||
    job.repository.name.toLowerCase() !== expected.name.toLowerCase() ||
    job.repository.commitSha.toLowerCase() !== expected.commitSha ||
    job.plan.contractVersion !== PRODUCTION_SMOKE_REQUEST.contractVersion ||
    job.plan.sourceRoot !== "." ||
    job.plan.packageManager !== "npm" ||
    job.plan.installCommand !== "npm ci" ||
    job.plan.buildCommand !== "npm run build" ||
    job.plan.outputDirectory !== "dist"
  ) {
    throw new ProductionSmokeError(
      "fixture identity",
      "The API did not return the pinned fixture and expected Vite/npm build plan.",
    )
  }
}

async function verifyJsonEndpoint(
  url: URL,
  fetch: typeof globalThis.fetch,
  timeoutMs: number,
  check: string,
  validate: (body: unknown) => boolean,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new ProductionSmokeError(check, "Endpoint could not be reached.")
  }
  if (response.status !== 200) {
    throw new ProductionSmokeError(
      check,
      `Expected HTTP 200, received ${String(response.status)}.`,
    )
  }
  const contentType = response.headers.get("content-type")
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ProductionSmokeError(check, "Response is not JSON.")
  }
  const text = await readBoundedText(
    response,
    HEALTH_RESPONSE_LIMIT_BYTES,
    check,
  )
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    throw new ProductionSmokeError(check, "Response contains malformed JSON.")
  }
  if (!validate(body)) {
    throw new ProductionSmokeError(check, "Response body is not healthy.")
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  check: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length")
  if (contentLength) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new ProductionSmokeError(check, "Response body exceeds its limit.")
    }
  }
  if (!response.body) {
    throw new ProductionSmokeError(check, "Response body is missing.")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new ProductionSmokeError(
          check,
          "Response body exceeds its limit.",
        )
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function apiFailure(check: string, error: unknown): ProductionSmokeError {
  if (error instanceof ProductionSmokeError) return error
  if (error instanceof PreviewApiError) {
    return new ProductionSmokeError(
      check,
      `Preview API request failed with ${error.code}${error.status ? ` (HTTP ${String(error.status)})` : ""}.`,
    )
  }
  return new ProductionSmokeError(check, "Preview API request failed.")
}

function readInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback
  if (!/^\d+$/.test(value)) {
    throw new ProductionSmokeError(
      "configuration",
      `${name} must be an integer.`,
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProductionSmokeError(
      "configuration",
      `${name} must be between ${String(minimum)} and ${String(maximum)}.`,
    )
  }
  return parsed
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
