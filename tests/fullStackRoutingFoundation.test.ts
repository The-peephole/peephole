import { describe, expect, it } from "vitest"

import {
  resolveProductionArtifactHostname,
  resolveProductionFullStackHostname,
} from "../services/production/artifactDomain"
import { validateFullStackRequestTarget } from "../services/fullstack-routing/httpPath"
import { PostgresFullStackRoutingStore } from "../services/fullstack-routing/postgresFullStackRoutingStore"

const base = "peepholeusercontent.dev"
const artifact = "artifact-11111111-2222-3333-4444-555555555555"
const fullstack = "fullstack-11111111-2222-3333-4444-555555555555"

describe("production preview hostname identities", () => {
  it("resolves canonical one-label artifact and full-stack hosts without collision", () => {
    expect(resolveProductionArtifactHostname(`${artifact}.${base}`, base)).toBe(
      artifact,
    )
    expect(
      resolveProductionFullStackHostname(`${fullstack}.${base}`, base),
    ).toBe(fullstack)
    expect(
      resolveProductionArtifactHostname(`${fullstack}.${base}`, base),
    ).toBeNull()
    expect(
      resolveProductionFullStackHostname(`${artifact}.${base}`, base),
    ).toBeNull()
  })

  it.each([
    `${fullstack}.${base}.`,
    `extra.${fullstack}.${base}`,
    `${fullstack}.${base}:443`,
    `https://${fullstack}.${base}`,
    ` ${fullstack}.${base}`,
  ])("rejects non-canonical full-stack hostname %j", (hostname) => {
    expect(resolveProductionFullStackHostname(hostname, base)).toBeNull()
  })

  it("normalizes hostname case consistently", () => {
    expect(
      resolveProductionFullStackHostname(
        `${fullstack}.${base}`.toUpperCase(),
        base,
      ),
    ).toBe(fullstack)
  })
})

describe("raw full-stack request-target validation", () => {
  it.each(["/api", "/api/", "/api/hello", "/api/hello?x=1"])(
    "routes only a canonical API path: %s",
    (target) => {
      expect(validateFullStackRequestTarget(target)).toMatchObject({
        raw: target,
        routesToBackend: true,
      })
    },
  )

  it.each(["/API/hello", "/apiary", "/", "/assets/api.js"])(
    "does not reserve %s",
    (target) => {
      expect(validateFullStackRequestTarget(target)).toMatchObject({
        routesToBackend: false,
      })
    },
  )

  it.each([
    "//api/hello",
    "/api/../secret",
    "/api/./hello",
    "/api/%2e%2e/secret",
    "/api/%2Fsecret",
    "/api/%2fsecret",
    "/api/%5Csecret",
    "/api/%5csecret",
    "/api\\hello",
    "/api/%00",
    "/api/%1f",
    "/api/%7f",
    "/api/%ZZ",
    "/api/%",
    "http://example.com/api",
    "https://example.com/api",
    "example.com:443",
    "/api#fragment",
  ])("rejects confused raw target %j", (target) => {
    expect(validateFullStackRequestTarget(target)).toBeNull()
  })

  it("bounds the complete target including its opaque query", () => {
    expect(
      validateFullStackRequestTarget(`/api?x=${"a".repeat(4096)}`),
    ).toBeNull()
  })
})

describe("PostgresFullStackRoutingStore", () => {
  it("selects and maps only serving-plane fields", async () => {
    const database = {
      query: async (sql: string, values?: readonly unknown[]) => {
        expect(sql).toContain(
          "SELECT id, status, artifact_id, backend_runtime_id, expires_at",
        )
        expect(sql).not.toMatch(
          /requester_id|request_fingerprint|frontend_job_id|repository|peer_ip|dial_target/,
        )
        expect(values).toEqual([fullstack])
        return {
          rowCount: 1,
          rows: [
            {
              id: fullstack,
              status: "ready",
              artifact_id: artifact,
              backend_runtime_id: "runtime-a",
              expires_at: "2026-09-22T00:00:00.000Z",
            },
          ],
        }
      },
    }
    const store = new PostgresFullStackRoutingStore(database as never)
    await expect(store.get(fullstack)).resolves.toEqual({
      id: fullstack,
      status: "ready",
      artifactId: artifact,
      backendRuntimeId: "runtime-a",
      expiresAt: new Date("2026-09-22T00:00:00.000Z"),
    })
  })
})
