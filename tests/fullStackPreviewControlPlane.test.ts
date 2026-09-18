import { describe, expect, it } from "vitest"

import type { PreviewRepositoryRef } from "../types/preview"
import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
  validBackendPlan,
  validFrontendPlan,
} from "./support/fakeFullStackPreview"

const otherRepository: PreviewRepositoryRef = {
  ...repository,
  commitSha: "b".repeat(40),
}

const requester = { subject: "user-1", ip: "203.0.113.10" }
const otherRequester = { subject: "user-2", ip: "203.0.113.20" }

function compose(
  options: {
    now?: Date
    maxActiveFullStackPreviewsPerRequester?: number
  } = {},
) {
  const store = new FakeFullStackPreviewStore()
  const queue = new FakeFullStackPreviewQueue()
  const frontendResolver = new FakeFrontendPlanResolver()
  const backendResolver = new FakeBackendPlanResolver()
  let clock = options.now ?? new Date("2026-01-01T00:00:00.000Z")
  const controlPlane = new FullStackPreviewControlPlane(
    frontendResolver,
    backendResolver,
    store,
    queue,
    {
      now: () => clock,
      maxActiveFullStackPreviewsPerRequester:
        options.maxActiveFullStackPreviewsPerRequester,
    },
  )
  return {
    controlPlane,
    store,
    queue,
    frontendResolver,
    backendResolver,
    setNow: (value: Date) => {
      clock = value
    },
  }
}

function createRequest(
  overrides: Partial<{
    repository: PreviewRepositoryRef
    frontendSourceRoot: string
    backendSourceRoot: string
  }> = {},
) {
  return {
    contractVersion: "fullstack-v1" as const,
    repository: overrides.repository ?? repository,
    frontendTarget: { sourceRoot: overrides.frontendSourceRoot ?? "frontend" },
    backendSourceRoot: overrides.backendSourceRoot ?? "backend",
  }
}

const idempotencyKey = "request-key-0123456789abcdef"

describe("FullStackPreviewControlPlane", () => {
  describe("request validation (B)", () => {
    it("rejects a bad repository ref", async () => {
      const { controlPlane } = compose()
      await expect(
        controlPlane.create(
          createRequest({ repository: { ...repository, repositoryId: -1 } }),
          idempotencyKey,
          requester,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    })

    it("rejects a bad full-stack contract version", async () => {
      const { controlPlane } = compose()
      const bad = {
        ...createRequest(),
        contractVersion: "fullstack-v2" as unknown as "fullstack-v1",
      }
      await expect(
        controlPlane.create(bad, idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    })

    it("rejects an unsafe frontend sourceRoot", async () => {
      const { controlPlane } = compose()
      await expect(
        controlPlane.create(
          createRequest({ frontendSourceRoot: "../escape" }),
          idempotencyKey,
          requester,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    })

    it("rejects an unsafe backend sourceRoot", async () => {
      const { controlPlane } = compose()
      await expect(
        controlPlane.create(
          createRequest({ backendSourceRoot: "../escape" }),
          idempotencyKey,
          requester,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    })

    it("rejects an unsupported frontend (resolver returns null)", async () => {
      const { controlPlane, frontendResolver } = compose()
      frontendResolver.nextPlan = null
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FRONTEND", status: 422 })
    })

    it("rejects an unsupported backend (resolver returns null)", async () => {
      const { controlPlane, backendResolver } = compose()
      backendResolver.nextPlan = null
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_BACKEND", status: 422 })
    })

    it("rejects when the frontend resolver returns the wrong repository", async () => {
      const { controlPlane, frontendResolver } = compose()
      frontendResolver.nextPlan = {
        ...validFrontendPlan,
        repository: otherRepository,
      }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("rejects when the frontend resolver returns the wrong commit", async () => {
      const { controlPlane, frontendResolver } = compose()
      frontendResolver.nextPlan = {
        ...validFrontendPlan,
        repository: { ...repository, commitSha: "c".repeat(40) },
      }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("rejects when the frontend resolver returns the wrong source root", async () => {
      const { controlPlane, frontendResolver } = compose()
      frontendResolver.nextPlan = { ...validFrontendPlan, sourceRoot: "other" }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("rejects when the backend resolver returns the wrong repository", async () => {
      const { controlPlane, backendResolver } = compose()
      backendResolver.nextPlan = {
        ...validBackendPlan,
        repository: otherRepository,
      }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("rejects when the backend resolver returns the wrong commit", async () => {
      const { controlPlane, backendResolver } = compose()
      backendResolver.nextPlan = {
        ...validBackendPlan,
        repository: { ...repository, commitSha: "c".repeat(40) },
      }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("rejects when the backend resolver returns the wrong source root", async () => {
      const { controlPlane, backendResolver } = compose()
      backendResolver.nextPlan = { ...validBackendPlan, sourceRoot: "other" }
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("never creates the underlying PreviewJob or BackendRuntime -- only resolves plans for validation", async () => {
      const { controlPlane, frontendResolver, backendResolver } = compose()
      const result = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      expect(result.created).toBe(true)
      expect(frontendResolver.calls).toHaveLength(1)
      expect(backendResolver.calls).toHaveLength(1)
      // The public/stored shape never carries a resolved plan or child id.
      expect(result.preview).not.toHaveProperty("plan")
      expect(result.preview).not.toHaveProperty("frontendJobId")
      expect(result.preview).not.toHaveProperty("backendRuntimeId")
    })
  })

  describe("idempotency (C)", () => {
    it("same key + same request returns the same resource", async () => {
      const { controlPlane } = compose()
      const first = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      const second = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      expect(second.created).toBe(false)
      expect(second.preview.id).toBe(first.preview.id)
    })

    it("same key + different request -> 409 CONFLICT", async () => {
      const { controlPlane } = compose()
      await controlPlane.create(createRequest(), idempotencyKey, requester)
      await expect(
        controlPlane.create(
          createRequest({ backendSourceRoot: "other-backend" }),
          idempotencyKey,
          requester,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
    })

    it("different idempotency keys mint distinct fullstack ids for the identical repo/commit/sourceRoots", async () => {
      // A separate concern from the admission cap (J) -- raised here so a
      // second, genuinely distinct request from the same requester isn't
      // incidentally blocked by it while proving id uniqueness.
      const { controlPlane } = compose({
        maxActiveFullStackPreviewsPerRequester: 2,
      })
      const first = await controlPlane.create(
        createRequest(),
        "request-key-aaaaaaaaaaaaaaaa",
        requester,
      )
      const second = await controlPlane.create(
        createRequest(),
        "request-key-bbbbbbbbbbbbbbbb",
        requester,
      )
      expect(first.preview.id).not.toBe(second.preview.id)
    })

    it("requester A's idempotency key does not collide with requester B's identical key", async () => {
      const { controlPlane } = compose()
      const a = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      const b = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        otherRequester,
      )
      expect(a.preview.id).not.toBe(b.preview.id)
    })
  })

  describe("ownership (D)", () => {
    it("requester mismatch on get -> 404", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await expect(
        controlPlane.get(preview.id, otherRequester),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      })
    })

    it("requester mismatch on cancel -> 404", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await expect(
        controlPlane.cancel(preview.id, otherRequester),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    })

    it("owner can get and cancel their own preview", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await expect(
        controlPlane.get(preview.id, requester),
      ).resolves.toMatchObject({
        id: preview.id,
      })
      await expect(
        controlPlane.cancel(preview.id, requester),
      ).resolves.toMatchObject({
        status: "cancelled",
      })
    })
  })

  describe("state machine (H)", () => {
    it("cannot jump queued -> ready through any control-plane method", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      expect(preview.status).toBe("queued")
      // markPhase's type signature already makes "ready" unreachable from
      // it at compile time; activateReady is the only method that could
      // ever produce "ready", and it refuses a still-queued preview both
      // because the status guard fails and because its child identities
      // are still null.
      await expect(
        controlPlane.activateReady(preview.id),
      ).rejects.toMatchObject({
        code: "INVALID_TRANSITION",
      })
      expect((await controlPlane.get(preview.id, requester)).status).toBe(
        "queued",
      )
    })

    it("accepts provisioning and teardown phases only in order", async () => {
      const { controlPlane, store } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await store.update(preview.id, (current) => ({
        ...current,
        status: "building_frontend",
      }))
      await expect(
        controlPlane.markPhase(preview.id, "starting_backend"),
      ).resolves.toMatchObject({ status: "starting_backend" })

      await store.update(preview.id, (current) => ({
        ...current,
        frontendJobId: "job-1",
        artifactId: "artifact-1",
        backendRuntimeId: "runtime-1",
      }))
      await expect(
        controlPlane.activateReady(preview.id),
      ).resolves.toMatchObject({ status: "ready" })
      await expect(
        controlPlane.markPhase(preview.id, "stopping"),
      ).resolves.toMatchObject({ status: "stopping" })
      await expect(
        controlPlane.markPhase(preview.id, "stopped"),
      ).resolves.toMatchObject({ status: "stopped" })
    })

    it("markPhase rejects an out-of-order transition", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      // Still "queued" -- markPhase's only legal source is "building_frontend".
      await expect(
        controlPlane.markPhase(preview.id, "starting_backend"),
      ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
      await expect(
        controlPlane.markPhase(preview.id, "stopping"),
      ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
      await expect(
        controlPlane.markPhase(preview.id, "stopped"),
      ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
    })

    it("terminal statuses do not become active again", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await controlPlane.cancel(preview.id, requester)
      const cancelledAgain = await controlPlane.cancel(preview.id, requester)
      expect(cancelledAgain.status).toBe("cancelled")
      expect(
        await controlPlane.isWorkerFullStackPreviewActive(preview.id),
      ).toBe(false)
    })

    it("activateReady refuses null child identities even when status is starting_backend", async () => {
      const { controlPlane, store } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await store.update(preview.id, (current) => ({
        ...current,
        status: "starting_backend",
      }))
      await expect(
        controlPlane.activateReady(preview.id),
      ).rejects.toMatchObject({
        code: "INVALID_TRANSITION",
      })
    })

    it("activateReady refuses starting_backend with only some child identities recorded", async () => {
      const { controlPlane, store } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await store.update(preview.id, (current) => ({
        ...current,
        status: "starting_backend",
        frontendJobId: "job-1",
        artifactId: "artifact-1",
        // backendRuntimeId intentionally still null
      }))
      await expect(
        controlPlane.activateReady(preview.id),
      ).rejects.toMatchObject({
        code: "INVALID_TRANSITION",
      })
    })

    it("activateReady succeeds once starting_backend and all three child identities are recorded", async () => {
      const { controlPlane, store } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await store.update(preview.id, (current) => ({
        ...current,
        status: "starting_backend",
        frontendJobId: "job-1",
        artifactId: "artifact-1",
        backendRuntimeId: "runtime-1",
      }))
      await expect(
        controlPlane.activateReady(preview.id),
      ).resolves.toMatchObject({
        status: "ready",
      })
    })

    it("activateReady refuses a preview not currently in starting_backend", async () => {
      const { controlPlane, store } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      await store.update(preview.id, (current) => ({
        ...current,
        frontendJobId: "job-1",
        artifactId: "artifact-1",
        backendRuntimeId: "runtime-1",
      }))
      // Still "queued".
      await expect(
        controlPlane.activateReady(preview.id),
      ).rejects.toMatchObject({
        code: "INVALID_TRANSITION",
      })
    })

    it("startWorkerFullStackPreview transitions queued -> building_frontend exactly once", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      expect(await controlPlane.startWorkerFullStackPreview(preview.id)).toBe(
        true,
      )
      expect(await controlPlane.startWorkerFullStackPreview(preview.id)).toBe(
        false,
      )
      const current = await controlPlane.get(preview.id, requester)
      expect(current.status).toBe("building_frontend")
    })
  })

  describe("admission cap (J)", () => {
    it("enforces the default active-preview limit per requester", async () => {
      const { controlPlane } = compose()
      await controlPlane.create(
        createRequest(),
        "request-key-first-000000",
        requester,
      )
      await expect(
        controlPlane.create(
          createRequest(),
          "request-key-second-00000",
          requester,
        ),
      ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 })
    })

    it("a terminal (cancelled) preview does not consume active capacity", async () => {
      const { controlPlane } = compose()
      const first = await controlPlane.create(
        createRequest(),
        "request-key-first-000000",
        requester,
      )
      await controlPlane.cancel(first.preview.id, requester)
      await expect(
        controlPlane.create(
          createRequest(),
          "request-key-second-00000",
          requester,
        ),
      ).resolves.toMatchObject({ created: true })
    })

    it("an idempotent retry is checked before the active-count limit is consumed", async () => {
      const { controlPlane } = compose({
        maxActiveFullStackPreviewsPerRequester: 1,
      })
      const first = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      expect(first.created).toBe(true)
      // Retried with the exact same key/request -- must return the SAME
      // resource without ever touching the (already-exhausted) admission
      // cap, i.e. it must not throw RATE_LIMITED.
      await expect(
        controlPlane.create(createRequest(), idempotencyKey, requester),
      ).resolves.toMatchObject({
        created: false,
        preview: { id: first.preview.id },
      })
    })
  })

  describe("public surface (I)", () => {
    it("never exposes internal orchestration identity or a fake url", async () => {
      const { controlPlane } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      const json = JSON.parse(JSON.stringify(preview))
      expect(json).not.toHaveProperty("frontendJobId")
      expect(json).not.toHaveProperty("artifactId")
      expect(json).not.toHaveProperty("backendRuntimeId")
      expect(json).not.toHaveProperty("peerIp")
      expect(json).not.toHaveProperty("dialTarget")
      expect(json).not.toHaveProperty("internalPort")
      expect(json).not.toHaveProperty("requesterId")
      expect(json).not.toHaveProperty("requestFingerprint")
      expect(json.url).toBeNull()
    })
  })

  describe("expiry", () => {
    it("a provisioning preview past its deadline fails closed with PROVISIONING_TIMEOUT", async () => {
      const { controlPlane, setNow } = compose()
      const { preview } = await controlPlane.create(
        createRequest(),
        idempotencyKey,
        requester,
      )
      setNow(new Date(Date.now() + 16 * 60_000))
      const refreshed = await controlPlane.get(preview.id, requester)
      expect(refreshed.status).toBe("failed")
      expect(refreshed.errorCode).toBe("PROVISIONING_TIMEOUT")
    })
  })
})
