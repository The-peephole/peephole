import { describe, expect, it } from "vitest"

import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import { createPreviewHttpHandler } from "../services/preview-api/http"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import type { BuildPlan, PreviewRequester } from "../types/preview"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
}

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const requester: PreviewRequester = {
  subject: "user-1",
  ip: "203.0.113.10",
}

describe("preview HTTP contract", () => {
  it("creates, reads, and cancels a job", async () => {
    const handle = createHandler()
    const create = await handle({
      method: "POST",
      path: "/v1/preview-jobs",
      headers: { "Idempotency-Key": "request-0000000001" },
      requester,
      body: {
        repository,
        contractVersion: "static-v1",
      },
    })

    expect(create.status).toBe(202)
    const job = getJob(create.body)
    expect(job.plan.buildCommand).toBe("npm run build")

    const status = await handle({
      method: "GET",
      path: `/v1/preview-jobs/${job.id}`,
      headers: {},
      requester,
    })
    expect(status).toMatchObject({ status: 200, body: { status: "queued" } })

    const cancel = await handle({
      method: "DELETE",
      path: `/v1/preview-jobs/${job.id}`,
      headers: {},
      requester,
    })
    expect(cancel).toMatchObject({
      status: 202,
      body: { status: "cancelled" },
    })
  })

  it("rejects client-supplied build commands", async () => {
    const handle = createHandler()
    const response = await handle({
      method: "POST",
      path: "/v1/preview-jobs",
      headers: { "Idempotency-Key": "request-0000000001" },
      requester,
      body: {
        repository,
        contractVersion: "static-v1",
        buildCommand: "malicious-command",
      },
    })

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_REQUEST" } },
    })
  })

  it("returns structured errors and Retry-After without internal details", async () => {
    const handle = createHandler({ perUser: 0 })
    const missingKey = await handle({
      method: "POST",
      path: "/v1/preview-jobs",
      headers: {},
      requester,
      body: { repository, contractVersion: "static-v1" },
    })
    const limited = await handle({
      method: "POST",
      path: "/v1/preview-jobs",
      headers: { "idempotency-key": "request-0000000001" },
      requester,
      body: { repository, contractVersion: "static-v1" },
    })

    expect(missingKey).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_REQUEST" } },
    })
    expect(limited).toMatchObject({
      status: 429,
      headers: { "retry-after": "60" },
      body: { error: { code: "RATE_LIMITED" } },
    })
    expect(JSON.stringify(limited)).not.toContain("stack")
  })

  it("does not reveal whether another requester's job exists", async () => {
    const handle = createHandler()
    const create = await handle({
      method: "POST",
      path: "/v1/preview-jobs",
      headers: { "idempotency-key": "request-0000000001" },
      requester,
      body: { repository, contractVersion: "static-v1" },
    })
    const job = getJob(create.body)
    const response = await handle({
      method: "GET",
      path: `/v1/preview-jobs/${job.id}`,
      headers: {},
      requester: { subject: "another-user", ip: requester.ip },
    })

    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: "NOT_FOUND" } },
    })
  })
})

function createHandler(options: { perUser?: number } = {}) {
  const control = new PreviewControlPlane(
    { resolve: async () => plan },
    new InMemoryPreviewJobStore(),
    new InMemoryPreviewQueue(),
    new InMemoryPreviewArtifactCache(),
    new HmacPreviewArtifactSigner(
      "peephole.run",
      "test-signing-secret-with-at-least-32-bytes",
    ),
    new FixedWindowPreviewQuota({ perUser: options.perUser }),
    {
      runnerVersion: "runner-v1",
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      createId: () => "job-00000001",
    },
  )

  return createPreviewHttpHandler(control)
}

function getJob(value: unknown): { id: string; plan: BuildPlan } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("job" in value) ||
    typeof value.job !== "object" ||
    value.job === null ||
    !("id" in value.job) ||
    typeof value.job.id !== "string" ||
    !("plan" in value.job)
  ) {
    throw new Error("Expected a preview job response")
  }

  return value.job as { id: string; plan: BuildPlan }
}
