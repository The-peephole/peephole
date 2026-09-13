import { describe, expect, it, vi } from "vitest"
import type { QueryResultRow } from "pg"

import type { PreviewApi } from "../core/preview/apiClient"
import {
  ProductionSmokeError,
  assertReadyJob,
  pollPreviewJob,
  readApiSmokeConfig,
  runProductionApiSmoke,
  validateArtifact,
  verifyServiceEndpoints,
  type ApiSmokeConfig,
} from "../scripts/production-smoke/api"
import { PRODUCTION_SMOKE_BUILD_PLAN } from "../scripts/production-smoke/fixture"
import {
  assertNoHostResidue,
  findHostResidue,
  readDatabaseCounts,
  type HostResidueSnapshot,
} from "../scripts/production-smoke/host"
import type {
  PostgresDatabase,
  SqlExecutor,
  SqlResult,
} from "../services/preview-api/postgres/database"
import type { PreviewJob } from "../types/preview"

const ARTIFACT_ID = "artifact-12345678-1234-1234-1234-123456789abc"
const ARTIFACT_DOMAIN = "artifacts.example.test"
const ARTIFACT_URL = `https://${ARTIFACT_ID}.${ARTIFACT_DOMAIN}/`

const apiConfig: ApiSmokeConfig = {
  apiBaseUrl: "https://api.example.test/",
  artifactBaseDomain: ARTIFACT_DOMAIN,
  sessionToken: "subject.4102444800.signature",
  sessionExpiresAt: "2100-01-01T00:00:00.000Z",
  pollIntervalMs: 500,
  pollTimeoutMs: 5_000,
  requestTimeoutMs: 1_000,
  artifactMaxBytes: 64 * 1024,
}

describe("production API smoke", () => {
  it("requires the session to cover the bounded smoke window", () => {
    const baseEnvironment = {
      PEEPHOLE_SMOKE_API_BASE_URL: "https://api.example.test",
      PEEPHOLE_SMOKE_ARTIFACT_BASE_DOMAIN: ARTIFACT_DOMAIN,
    }

    expect(
      readApiSmokeConfig(
        {
          ...baseEnvironment,
          PEEPHOLE_SMOKE_SESSION_TOKEN: "subject.700.signature",
        },
        0,
      ),
    ).toMatchObject({
      apiBaseUrl: "https://api.example.test/",
      artifactBaseDomain: ARTIFACT_DOMAIN,
    })
    expect(() =>
      readApiSmokeConfig(
        {
          ...baseEnvironment,
          PEEPHOLE_SMOKE_SESSION_TOKEN: "subject.600.signature",
        },
        0,
      ),
    ).toThrow(/reconnect GitHub/)
  })

  it("fails when public health is not HTTP 200", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(503, { ok: false }))

    await expect(
      verifyServiceEndpoints(
        "https://api.example.test/",
        fetch,
        1_000,
        "public",
      ),
    ).rejects.toMatchObject({ check: "public health" })
  })

  it("fails when public readiness is not ready", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(503, { ready: false }))

    await expect(
      verifyServiceEndpoints(
        "https://api.example.test/",
        fetch,
        1_000,
        "public",
      ),
    ).rejects.toMatchObject({ check: "public readiness" })
  })

  it("polls bounded active states until the job is ready", async () => {
    let now = 0
    const api = fakeApi([job({ status: "building" }), job({ status: "ready" })])

    await expect(
      pollPreviewJob(api, job({ status: "queued" }), {
        timeoutMs: 2_000,
        intervalMs: 500,
        requestTimeoutMs: 1_000,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      }),
    ).resolves.toMatchObject({ status: "ready" })
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("fails immediately when a job reaches a terminal failure", async () => {
    const failed = job({ status: "failed", errorCode: "BUILD_FAILED" })

    await expect(
      pollPreviewJob(fakeApi([]), failed, {
        timeoutMs: 2_000,
        intervalMs: 500,
        requestTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ check: "job ready" })
  })

  it("fails after the configured polling timeout", async () => {
    let now = 0
    const api = fakeApi([job({ status: "queued" }), job({ status: "queued" })])

    await expect(
      pollPreviewJob(api, job({ status: "queued" }), {
        timeoutMs: 1_000,
        intervalMs: 500,
        requestTimeoutMs: 1_000,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      }),
    ).rejects.toMatchObject({ check: "job polling" })
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("rejects a malformed Preview API success response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        const pathname = new URL(String(input)).pathname
        if (pathname === "/healthz") return jsonResponse(200, { ok: true })
        if (pathname === "/readyz") return jsonResponse(200, { ready: true })
        return jsonResponse(202, { created: true, job: { status: "ready" } })
      })

    await expect(
      runProductionApiSmoke(apiConfig, { fetch }),
    ).rejects.toMatchObject({ check: "preview job creation" })
  })

  it("rejects non-HTTPS artifacts", () => {
    expect(() =>
      assertReadyJob(
        job({ artifactUrl: `http://${ARTIFACT_ID}.${ARTIFACT_DOMAIN}/` }),
        ARTIFACT_DOMAIN,
      ),
    ).toThrow(ProductionSmokeError)
  })

  it("rejects artifacts outside the configured host", () => {
    expect(() =>
      assertReadyJob(
        job({ artifactUrl: `https://${ARTIFACT_ID}.evil.example/` }),
        ARTIFACT_DOMAIN,
      ),
    ).toThrow(ProductionSmokeError)
  })

  it("fails artifact validation on a non-200 response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("not found", { status: 404 }))

    await expect(
      validateArtifact(ARTIFACT_URL, ARTIFACT_DOMAIN, fetch, {
        timeoutMs: 1_000,
        maxBytes: 64 * 1024,
        expectedMarker: "fixture marker",
      }),
    ).rejects.toMatchObject({ check: "artifact" })
  })

  it("bounds the artifact response body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(htmlResponse("x".repeat(65 * 1024)))

    await expect(
      validateArtifact(ARTIFACT_URL, ARTIFACT_DOMAIN, fetch, {
        timeoutMs: 1_000,
        maxBytes: 64 * 1024,
        expectedMarker: "fixture marker",
      }),
    ).rejects.toThrow(/exceeds/)
  })

  it("accepts an existing first hit and requires the follow-up cache hit", async () => {
    const first = job({ id: "job-00000001", cacheStatus: "hit" })
    const second = job({ id: "job-00000002", cacheStatus: "hit" })
    const api = fakeApi([], [first, second])
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        const pathname = new URL(String(input)).pathname
        if (pathname === "/healthz") return jsonResponse(200, { ok: true })
        if (pathname === "/readyz") return jsonResponse(200, { ready: true })
        return htmlResponse(
          "<!doctype html><title>Peephole Vite React Fixture</title>",
        )
      })

    await expect(
      runProductionApiSmoke(apiConfig, {
        api,
        fetch,
        sleep: async () => undefined,
        randomId: () => "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toMatchObject({
      firstJob: { id: first.id, cacheStatus: "hit" },
      cachedJob: { id: second.id, cacheStatus: "hit" },
    })
  })
})

describe("production host residue", () => {
  it.each([
    {
      name: "zero queue rows",
      jobStatuses: [],
      queueRows: [],
      expected: { activeJobs: 0, actionableQueueRows: 0 },
    },
    {
      name: "a cancelled queue row only",
      jobStatuses: ["cancelled"],
      queueRows: [{ status: "cancelled" }],
      expected: { activeJobs: 0, actionableQueueRows: 0 },
    },
    {
      name: "a queued row",
      jobStatuses: ["queued"],
      queueRows: [{ status: "queued" }],
      expected: { activeJobs: 1, actionableQueueRows: 1 },
    },
    {
      name: "a leased row with a valid lease",
      jobStatuses: ["building"],
      queueRows: [{ status: "leased", leaseExpiresAt: "2100-01-01" }],
      expected: { activeJobs: 1, actionableQueueRows: 1 },
    },
    {
      name: "a leased row with an expired lease",
      jobStatuses: ["queued"],
      queueRows: [{ status: "leased", leaseExpiresAt: "2000-01-01" }],
      expected: { activeJobs: 1, actionableQueueRows: 1 },
    },
    {
      name: "an active job without a queue row",
      jobStatuses: ["publishing"],
      queueRows: [],
      expected: { activeJobs: 1, actionableQueueRows: 0 },
    },
  ])("counts $name according to worker lease semantics", async (fixture) => {
    await expect(
      readDatabaseCounts(
        databaseWithQueueState(fixture.jobStatuses, fixture.queueRows),
      ),
    ).resolves.toEqual(fixture.expected)
  })

  it("returns a failure for Peephole-owned residue", () => {
    const snapshot = emptyHostSnapshot()
    snapshot.runscContainers.push("container@/var/lib/peephole/jobs/bundle")
    snapshot.networkLeaseEntries.push("7")
    snapshot.namespaces.push("peephole-7")
    snapshot.links.push("veph7")
    snapshot.ipv4Rules.push("-A FORWARD -i veph7 -j ppe7")
    snapshot.mounts.push({
      target:
        "/var/lib/peephole/jobs/peephole-0123456789abcdef0123456789abcdef/workspace",
      source: "/dev/loop7",
      fstype: "ext4",
    })
    snapshot.loopDevices.push({
      name: "/dev/loop7",
      backingFile:
        "/var/lib/peephole/jobs/peephole-0123456789abcdef0123456789abcdef/workspace.img",
    })
    snapshot.bundleEntries.push("peephole-0123456789abcdef0123456789abcdef")

    const report = findHostResidue(snapshot, "/var/lib/peephole/jobs")
    expect(() => assertNoHostResidue(report)).toThrow(/Cleanup did not/)
    expect(report).toMatchObject({
      runsc: expect.any(Array),
      networkLeases: ["7"],
      namespacesAndVeths: ["peephole-7", "veph7"],
      firewall: ["-A FORWARD -i veph7 -j ppe7"],
    })
  })

  it("accepts an empty host snapshot and ignores unrelated names", () => {
    const snapshot = emptyHostSnapshot()
    snapshot.bundleEntries.push("operator-notes")
    snapshot.networkLeaseEntries.push("unrelated")
    snapshot.links.push("eth0")

    const report = findHostResidue(snapshot, "/var/lib/peephole/jobs")
    expect(() => assertNoHostResidue(report)).not.toThrow()
    expect(Object.values(report).flat()).toEqual([])
  })
})

function job(
  options: {
    id?: string
    status?: PreviewJob["status"]
    cacheStatus?: PreviewJob["cacheStatus"]
    errorCode?: PreviewJob["errorCode"]
    artifactUrl?: string
  } = {},
): PreviewJob {
  const status = options.status ?? "ready"
  return {
    id: options.id ?? "job-00000001",
    repository: { ...PRODUCTION_SMOKE_BUILD_PLAN.repository },
    plan: {
      ...PRODUCTION_SMOKE_BUILD_PLAN,
      repository: { ...PRODUCTION_SMOKE_BUILD_PLAN.repository },
    },
    cacheKey: "production-cache-key",
    cacheStatus: options.cacheStatus ?? "miss",
    status,
    artifact:
      status === "ready"
        ? {
            url: options.artifactUrl ?? ARTIFACT_URL,
            expiresAt: "2100-01-01T00:00:00.000Z",
          }
        : null,
    errorCode: options.errorCode ?? null,
    errorMessage: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
  }
}

function fakeApi(
  getJobs: PreviewJob[],
  createJobs: PreviewJob[] = [],
): PreviewApi {
  return {
    create: vi.fn(async () => {
      const next = createJobs.shift()
      if (!next) throw new Error("unexpected create")
      return next
    }),
    get: vi.fn(async () => {
      const next = getJobs.shift()
      if (!next) throw new Error("unexpected get")
      return next
    }),
    cancel: vi.fn(async () => {
      throw new Error("unexpected cancel")
    }),
  }
}

function emptyHostSnapshot(): HostResidueSnapshot {
  return {
    runscContainers: [],
    bundleEntries: [],
    networkLeaseEntries: [],
    namespaces: [],
    links: [],
    ipv4Rules: [],
    natRules: [],
    ipv6Rules: [],
    mounts: [],
    loopDevices: [],
  }
}

function databaseWithQueueState(
  jobStatuses: string[],
  queueRows: Array<{ status: string; leaseExpiresAt?: string }>,
): PostgresDatabase {
  const client: SqlExecutor = {
    query: async <Row extends QueryResultRow = QueryResultRow>(
      text: string,
    ): Promise<SqlResult<Row>> => {
      const normalized = text.replace(/\s+/gu, " ").trim()
      if (normalized === "SET TRANSACTION READ ONLY") {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes("FROM peephole_preview_jobs")) {
        const active = new Set([
          "queued",
          "fetching",
          "installing",
          "building",
          "publishing",
        ])
        return countResult(
          jobStatuses.filter((status) => active.has(status)).length,
        )
      }
      if (normalized.includes("FROM peephole_preview_queue")) {
        expect(normalized).toContain("WHERE status IN ('queued', 'leased')")
        return countResult(
          queueRows.filter(({ status }) =>
            ["queued", "leased"].includes(status),
          ).length,
        )
      }
      throw new Error(`Unexpected SQL in test: ${normalized}`)
    },
  }

  return {
    query: client.query,
    transaction: async <T>(operation: (executor: SqlExecutor) => Promise<T>) =>
      operation(client),
    ping: async () => true,
    close: async () => undefined,
  }
}

function countResult<Row extends QueryResultRow = QueryResultRow>(
  count: number,
): SqlResult<Row> {
  return {
    rows: [{ count: String(count) } as unknown as Row],
    rowCount: 1,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}
