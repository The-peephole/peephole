import { afterEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import {
  startNodePreviewApi,
  type RunningNodePreviewApi,
} from "../services/preview-api/startNodeServer"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
  validFrontendPlan,
} from "./support/fakeFullStackPreview"

describe("production API full-stack routing seam", () => {
  let api: RunningNodePreviewApi | undefined
  afterEach(async () => api?.stop())

  it("routes static and full-stack endpoints through one authenticated listener", async () => {
    const staticControl = new PreviewControlPlane(
      { resolve: async () => validFrontendPlan },
      new InMemoryPreviewJobStore(),
      new InMemoryPreviewQueue(),
      new InMemoryPreviewArtifactCache(),
      new HmacPreviewArtifactSigner(
        "peephole.run",
        "test-signing-secret-with-at-least-32-bytes",
      ),
      new FixedWindowPreviewQuota(),
      { runnerVersion: "production-test", createId: () => "job-00000001" },
    )
    const fullStackControl = new FullStackPreviewControlPlane(
      new FakeFrontendPlanResolver(),
      new FakeBackendPlanResolver(),
      new FakeFullStackPreviewStore(),
      new FakeFullStackPreviewQueue(),
      { consume: async () => ({ allowed: true as const }) },
      {
        createId: () => "fullstack-00000000-0000-0000-0000-000000000001",
      },
    )
    const resolveRequester = vi.fn(() => ({
      subject: "user-1",
      ip: "127.0.0.1",
    }))
    api = await startNodePreviewApi({
      controlPlane: staticControl,
      fullStackControlPlane: fullStackControl,
      config: {
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 16 * 1024,
        requestTimeoutMs: 5_000,
      },
      resolveRequester,
      isReady: () => true,
    })
    const base = `http://127.0.0.1:${String(api.address.port)}`

    const staticResponse = await fetch(`${base}/v1/preview-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "static-request-00000001",
      },
      body: JSON.stringify({
        repository,
        contractVersion: "static-v2",
        target: { sourceRoot: "frontend" },
      }),
    })
    const fullStackResponse = await fetch(`${base}/v1/fullstack-previews`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "fullstack-request-000001",
      },
      body: JSON.stringify({
        repository,
        contractVersion: "fullstack-v1",
        frontendTarget: { sourceRoot: "frontend" },
        backendSourceRoot: "backend",
      }),
    })

    expect(staticResponse.status).toBe(202)
    expect(fullStackResponse.status).toBe(202)
    await expect(fullStackResponse.json()).resolves.toMatchObject({
      preview: {
        id: "fullstack-00000000-0000-0000-0000-000000000001",
        status: "queued",
      },
    })
    expect(resolveRequester).toHaveBeenCalledTimes(2)
  })
})
