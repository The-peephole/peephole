import { readFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GitHubClient } from "../core/github/client"
import type { PreviewControlPlane } from "../services/preview-api/controlPlane"
import { GITHUB_GATEWAY_HEADER } from "../services/preview-api/githubGateway"
import { createConfiguredGitHubGateway } from "../services/preview-api/githubGatewayConfig"
import {
  startNodePreviewApi,
  type RunningNodePreviewApi,
} from "../services/preview-api/startNodeServer"
import { createGitHubFixture } from "./support/githubGatewayFixture"

const ADMISSION_TOKEN = "github_pat_mock_admission_only"
const GATEWAY_TOKEN = "ghp_mock_gateway_only"
const REQUEST = {
  method: "POST" as const,
  path: "/v1/github/rest",
  headers: {},
  body: { path: "/repos/acme/fullstack" },
  requester: { subject: "github:1", ip: "203.0.113.1" },
}

describe("dedicated GitHub gateway configuration", () => {
  // Plain environment objects avoid changing process-global credentials.
  it("stays disabled without either server token", () => {
    expect(
      createConfiguredGitHubGateway({
        PEEPHOLE_GITHUB_GATEWAY_ENABLED: "true",
      }),
    ).toBeNull()
  })

  it("preserves the admission client's existing credential with both tokens configured", async () => {
    const environment = {
      PEEPHOLE_GITHUB_TOKEN: ADMISSION_TOKEN,
      PEEPHOLE_GITHUB_GATEWAY_TOKEN: GATEWAY_TOKEN,
    }
    const { fetcher } = createGitHubFixture()
    const client = new GitHubClient({
      getToken: () => environment.PEEPHOLE_GITHUB_TOKEN,
      fetcher,
    })
    await client.getRepositoryMetadata({ owner: "acme", repo: "fullstack" })
    expect(fetcher).toHaveBeenCalled()
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${ADMISSION_TOKEN}`,
      )
    }
  })

  it.each([undefined, "false", "TRUE", "1"])(
    "stays off for flag %s even with both tokens",
    (flag) => {
      expect(
        createConfiguredGitHubGateway({
          PEEPHOLE_GITHUB_GATEWAY_ENABLED: flag,
          PEEPHOLE_GITHUB_TOKEN: ADMISSION_TOKEN,
          PEEPHOLE_GITHUB_GATEWAY_TOKEN: GATEWAY_TOKEN,
        }),
      ).toBeNull()
    },
  )

  it.each([undefined, ""])(
    "never substitutes the admission token for dedicated token %s",
    (token) => {
      expect(
        createConfiguredGitHubGateway({
          PEEPHOLE_GITHUB_GATEWAY_ENABLED: "true",
          PEEPHOLE_GITHUB_TOKEN: ADMISSION_TOKEN,
          PEEPHOLE_GITHUB_GATEWAY_TOKEN: token,
        }),
      ).toBeNull()
    },
  )

  it.each([undefined, ADMISSION_TOKEN])(
    "uses only the dedicated token with admission token %s",
    async (admissionToken) => {
      const { fetcher } = createGitHubFixture()
      const log = vi.fn()
      const gateway = createConfiguredGitHubGateway(
        {
          PEEPHOLE_GITHUB_GATEWAY_ENABLED: "true",
          PEEPHOLE_GITHUB_TOKEN: admissionToken,
          PEEPHOLE_GITHUB_GATEWAY_TOKEN: GATEWAY_TOKEN,
        },
        { fetcher, log },
      )
      expect(gateway).not.toBeNull()
      const response = await gateway!.handle(REQUEST)
      expect(response.status).toBe(200)
      expect(response.headers[GITHUB_GATEWAY_HEADER]).toBe("1")
      expect(fetcher).toHaveBeenCalled()
      for (const [, init] of fetcher.mock.calls) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${GATEWAY_TOKEN}`,
        )
      }
      const exposed = JSON.stringify([response, log.mock.calls])
      expect(exposed).not.toContain(GATEWAY_TOKEN)
      expect(exposed).not.toContain(ADMISSION_TOKEN)
    },
  )

  it.each([
    ["fine-grained", "github_pat_mock_gateway", ""],
    ["scoped classic", GATEWAY_TOKEN, "public_repo"],
    ["unverifiable scopes", GATEWAY_TOKEN, null],
  ])("preserves the guard for %s credentials", async (_, token, scopes) => {
    const { fetcher } = createGitHubFixture({ scopes })
    const log = vi.fn()
    const gateway = createConfiguredGitHubGateway(
      {
        PEEPHOLE_GITHUB_GATEWAY_ENABLED: "true",
        PEEPHOLE_GITHUB_TOKEN: ADMISSION_TOKEN,
        PEEPHOLE_GITHUB_GATEWAY_TOKEN: token!,
      },
      { fetcher, log },
    )!
    const response = await gateway.handle(REQUEST)
    expect(response.status).toBe(503)
    expect(response.headers[GITHUB_GATEWAY_HEADER]).toBe("disabled")
    expect(log).toHaveBeenCalled()
    expect(
      fetcher.mock.calls.every(([url]) => String(url).includes("/user/repos")),
    ).toBe(true)
    const exposed = JSON.stringify([response, log.mock.calls])
    expect(exposed).not.toContain(token)
    expect(exposed).not.toContain(ADMISSION_TOKEN)
  })

  it.each([
    "services/production/server.ts",
    "services/local-preview/devServer.ts",
  ])(
    "%s keeps admission on its existing token and uses shared gateway configuration",
    async (file) => {
      const source = await readFile(path.resolve(file), "utf8")
      expect(source).toContain(
        "getToken: () => process.env.PEEPHOLE_GITHUB_TOKEN",
      )
      expect(source).toContain("createConfiguredGitHubGateway(process.env)")
      expect(source).not.toContain("new GitHubGateway(")
    },
  )

  const servers: RunningNodePreviewApi[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  })

  it("keeps existing preview requests working when only the admission token is configured", async () => {
    const { fetcher } = createGitHubFixture()
    const gateway = createConfiguredGitHubGateway(
      {
        PEEPHOLE_GITHUB_GATEWAY_ENABLED: "true",
        PEEPHOLE_GITHUB_TOKEN: ADMISSION_TOKEN,
      },
      { fetcher },
    )
    const get = vi
      .fn()
      .mockResolvedValue({ id: "preview-existing", status: "ready" })
    const server = await startNodePreviewApi({
      controlPlane: { get } as unknown as PreviewControlPlane,
      githubGateway: gateway ? (request) => gateway.handle(request) : undefined,
      config: {
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 16 * 1024,
        requestTimeoutMs: 15_000,
      },
      resolveRequester: () => REQUEST.requester,
      isReady: () => true,
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.address.port}`
    const disabled = await fetch(`${base}/v1/github/rest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQUEST.body),
    })
    expect(disabled.status).toBe(503)
    expect(disabled.headers.get(GITHUB_GATEWAY_HEADER)).toBe("disabled")
    expect(await disabled.text()).not.toContain(ADMISSION_TOKEN)
    const preview = await fetch(`${base}/v1/preview-jobs/preview-existing`)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toEqual({
      id: "preview-existing",
      status: "ready",
    })
    expect(get).toHaveBeenCalledWith("preview-existing", REQUEST.requester)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
