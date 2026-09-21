import { describe, expect, it, vi } from "vitest"

import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import type { StoredFullStackPreview } from "../services/fullstack-preview-api/ports"
import { FullStackPreviewStartupReconciler } from "../services/fullstack-preview-worker/startupReconciler"
import type { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
} from "./support/fakeFullStackPreview"

const statuses = [
  "queued",
  "building_frontend",
  "starting_backend",
  "awaiting_activation",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "cancelled",
  "expired",
] as const

describe("FullStackPreviewStartupReconciler", () => {
  it("retains queued, fails stale active/ready, stops stopping, and discards every terminal delivery", async () => {
    const store = new FakeFullStackPreviewStore()
    const queue = new FakeFullStackPreviewQueue()
    const fullStack = new FullStackPreviewControlPlane(
      new FakeFrontendPlanResolver(),
      new FakeBackendPlanResolver(),
      store,
      queue,
      { consume: async () => ({ allowed: true as const }) },
      { now: () => new Date("2026-09-21T00:00:00.000Z") },
    )
    const getForOrchestration = vi.fn(async () => ({ status: "building" }))
    const cancelForOrchestration = vi.fn(async () => ({ status: "cancelled" }))
    const frontend = {
      getForOrchestration,
      cancelForOrchestration,
    } as unknown as PreviewControlPlane

    for (const [index, status] of statuses.entries()) {
      const preview = fixture(index, status)
      await store.createOrGetWithCapacity({
        requesterId: preview.requesterId,
        idempotencyKey: `request-key-${String(index).padStart(16, "0")}`,
        requestFingerprint: preview.requestFingerprint,
        preview,
        maxActive: 100,
      })
    }

    await new FullStackPreviewStartupReconciler(
      store,
      queue,
      fullStack,
      frontend,
    ).reconcile()

    const reconciled = await store.listAll()
    expect(reconciled.find((row) => row.status === "queued")).toBeDefined()
    for (const original of [
      "building_frontend",
      "starting_backend",
      "awaiting_activation",
      "ready",
    ]) {
      const row = reconciled.find((item) =>
        item.id.endsWith(
          String(statuses.indexOf(original as never)).padStart(12, "0"),
        ),
      )
      expect(row).toMatchObject({
        status: "failed",
        errorCode: "ORCHESTRATION_UNAVAILABLE",
      })
    }
    expect(reconciled[statuses.indexOf("stopping")]).toMatchObject({
      status: "stopped",
    })
    expect(queue.cancelled).toHaveLength(statuses.length - 1)
    expect(queue.cancelled).not.toContain(fixture(0, "queued").id)
    expect(cancelForOrchestration).toHaveBeenCalledTimes(5)
    expect(JSON.stringify(reconciled)).not.toMatch(/peerIp|dialTarget/)
  })

  it("fails startup when authoritative static-child cleanup fails", async () => {
    const store = new FakeFullStackPreviewStore()
    const queue = new FakeFullStackPreviewQueue()
    const fullStack = new FullStackPreviewControlPlane(
      new FakeFrontendPlanResolver(),
      new FakeBackendPlanResolver(),
      store,
      queue,
      { consume: async () => ({ allowed: true as const }) },
    )
    const preview = fixture(1, "building_frontend")
    await store.createOrGetWithCapacity({
      requesterId: preview.requesterId,
      idempotencyKey: "request-key-000000000001",
      requestFingerprint: preview.requestFingerprint,
      preview,
      maxActive: 10,
    })
    const failure = new Error("database unavailable")
    const frontend = {
      getForOrchestration: vi.fn().mockRejectedValue(failure),
    } as unknown as PreviewControlPlane

    await expect(
      new FullStackPreviewStartupReconciler(
        store,
        queue,
        fullStack,
        frontend,
      ).reconcile(),
    ).rejects.toBe(failure)
    expect(queue.cancelled).toEqual([])
  })
})

function fixture(
  index: number,
  status: (typeof statuses)[number],
): StoredFullStackPreview {
  return {
    id: `fullstack-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    requesterId: `user-${String(index)}`,
    requestFingerprint: `fingerprint-${String(index)}`,
    repository,
    frontendSourceRoot: "frontend",
    backendSourceRoot: "backend",
    status,
    url:
      status === "ready"
        ? `https://fullstack-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.peepholeusercontent.dev/`
        : null,
    frontendJobId: `frontend-job-${String(index)}`,
    artifactId: `artifact-${String(index)}`,
    backendRuntimeId: `backend-runtime-${String(index)}`,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2026-09-22T00:00:00.000Z",
  }
}
