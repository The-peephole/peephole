import { afterEach, describe, expect, it } from "vitest"

import type { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  GITHUB_GATEWAY_HEADER,
  GITHUB_GATEWAY_PATH,
  GitHubGateway,
} from "../services/preview-api/githubGateway"
import { PreviewSessionIssuer } from "../services/preview-api/previewSession"
import { PreviewSessionAuth } from "../services/preview-api/previewSessionAuth"
import {
  startNodePreviewApi,
  type RunningNodePreviewApi,
} from "../services/preview-api/startNodeServer"
import {
  SERVER_TOKEN,
  createGitHubFixture,
} from "./support/githubGatewayFixture"

const SECRET = "s".repeat(48)

describe("GitHub gateway over the Preview API", () => {
  const servers: RunningNodePreviewApi[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  })

  async function start(withGateway: boolean) {
    const { fetcher } = createGitHubFixture()
    const issuer = new PreviewSessionIssuer(SECRET)
    const auth = new PreviewSessionAuth(issuer)
    const gateway = new GitHubGateway({ token: SERVER_TOKEN, fetcher })
    const server = await startNodePreviewApi({
      controlPlane: {} as PreviewControlPlane,
      githubGateway: withGateway
        ? (request) => gateway.handle(request)
        : undefined,
      config: {
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 16 * 1024,
        requestTimeoutMs: 15_000,
      },
      resolveRequester: (request) => auth.resolve(request),
      isReady: () => true,
    })
    servers.push(server)
    const post = (
      token: string | null,
      body: unknown = { path: "/repos/acme/fullstack" },
    ) =>
      fetch(`http://127.0.0.1:${server.address.port}${GITHUB_GATEWAY_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
    return { issuer, post, fetcher }
  }

  it("serves a signed-in caller", async () => {
    const { issuer, post } = await start(true)
    const session = await issuer.issue("github:1")

    const response = await post(session.token)

    expect(response.status).toBe(200)
    expect(response.headers.get(GITHUB_GATEWAY_HEADER)).toBe("1")
    expect(await response.text()).not.toContain(SERVER_TOKEN)
  })

  it("rejects missing, forged, and expired sessions before any GitHub call", async () => {
    const { issuer, post, fetcher } = await start(true)
    const valid = await issuer.issue("github:1")
    const [payload, expiry] = valid.token.split(".")
    const forged = `${payload}.${expiry}.${"A".repeat(43)}`
    const expired = await new PreviewSessionIssuer(SECRET, {
      now: () => new Date(Date.now() - 2 * 60 * 60 * 1000),
    }).issue("github:1")
    const otherKey = await new PreviewSessionIssuer("o".repeat(48)).issue(
      "github:1",
    )

    for (const token of [null, forged, expired.token, otherKey.token, "x"]) {
      const response = await post(token)
      expect(response.status).toBe(401)
      expect(response.headers.get(GITHUB_GATEWAY_HEADER)).toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("answers disabled when the gateway is not configured", async () => {
    const { issuer, post } = await start(false)
    const session = await issuer.issue("github:1")

    const response = await post(session.token)

    expect(response.status).toBe(503)
    expect(response.headers.get(GITHUB_GATEWAY_HEADER)).toBe("disabled")
  })
})
