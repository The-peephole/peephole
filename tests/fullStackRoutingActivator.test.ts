import { describe, expect, it, vi } from "vitest"

import type { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import type { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import type { StoredFullStackPreview } from "../services/fullstack-preview-api/ports"
import { FullStackRoutingActivator } from "../services/fullstack-routing/fullStackRoutingActivator"

const now = new Date("2026-09-21T00:00:00.000Z")
const previewId = "fullstack-11111111-2222-3333-4444-555555555555"
const artifactId = "artifact-11111111-2222-3333-4444-555555555555"
const runtimeId = "runtime-11111111"

const parent: StoredFullStackPreview = {
  id: previewId,
  requesterId: "user-1",
  requestFingerprint: "fingerprint",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "a".repeat(40),
  },
  frontendSourceRoot: "frontend",
  backendSourceRoot: "backend",
  status: "awaiting_activation",
  url: null,
  frontendJobId: "job-1",
  artifactId,
  backendRuntimeId: runtimeId,
  errorCode: null,
  errorMessage: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  expiresAt: "2026-09-21T00:30:00.000Z",
}

function harness(
  overrides: {
    parent?: StoredFullStackPreview | null
    artifactExpiry?: Date | null
    runtimeStatus?: "running" | "stopped"
    runtimeExpiry?: string
    live?: boolean
  } = {},
) {
  const storedParent =
    overrides.parent === undefined ? parent : overrides.parent
  const getWorkerFullStackPreview = vi.fn().mockResolvedValue(storedParent)
  const activateRouting = vi.fn(async (_id, input) => ({
    id: previewId,
    status: "ready",
    url: input.url,
    expiresAt: input.expiresAt.toISOString(),
  }))
  const getArtifact = vi.fn().mockResolvedValue(
    overrides.artifactExpiry === null
      ? null
      : {
          expiresAt:
            overrides.artifactExpiry ?? new Date("2026-09-21T00:20:00.000Z"),
        },
  )
  const getForOrchestration = vi.fn().mockResolvedValue({
    id: runtimeId,
    status: overrides.runtimeStatus ?? "running",
    expiresAt: overrides.runtimeExpiry ?? "2026-09-21T00:10:00.000Z",
  })
  const resolve = vi
    .fn()
    .mockReturnValue(
      overrides.live === false ? undefined : { host: "10.0.0.2", port: 3000 },
    )
  const activator = new FullStackRoutingActivator({
    fullStackControlPlane: {
      getWorkerFullStackPreview,
      activateRouting,
    } as unknown as FullStackPreviewControlPlane,
    artifactStore: { get: getArtifact },
    backendControlPlane: {
      getForOrchestration,
    } as unknown as BackendRuntimeControlPlane,
    liveRuntimeResolver: { resolve },
    baseDomain: "peepholeusercontent.dev",
    now: () => now,
  })
  return {
    activator,
    getArtifact,
    getForOrchestration,
    resolve,
    activateRouting,
  }
}

describe("FullStackRoutingActivator", () => {
  it("uses all authorities, tightens expiry, and generates the canonical URL", async () => {
    const h = harness()
    await expect(h.activator.activate(previewId)).resolves.toMatchObject({
      status: "ready",
      url: `https://${previewId}.peepholeusercontent.dev/`,
      expiresAt: "2026-09-21T00:10:00.000Z",
    })
    expect(h.getArtifact).toHaveBeenCalledWith(artifactId)
    expect(h.getForOrchestration).toHaveBeenCalledWith(runtimeId, "user-1")
    expect(h.resolve).toHaveBeenCalledWith(runtimeId)
    expect(h.activateRouting).toHaveBeenCalledWith(previewId, {
      expectedArtifactId: artifactId,
      expectedBackendRuntimeId: runtimeId,
      url: `https://${previewId}.peepholeusercontent.dev/`,
      expiresAt: new Date("2026-09-21T00:10:00.000Z"),
    })
  })

  it.each([
    ["parent missing", { parent: null }],
    ["parent not awaiting", { parent: { ...parent, status: "queued" } }],
    ["artifact id missing", { parent: { ...parent, artifactId: null } }],
    ["runtime id missing", { parent: { ...parent, backendRuntimeId: null } }],
    ["frontend id missing", { parent: { ...parent, frontendJobId: null } }],
    ["artifact metadata missing", { artifactExpiry: null }],
    ["artifact expired", { artifactExpiry: now }],
    ["backend not running", { runtimeStatus: "stopped" }],
    ["backend expired", { runtimeExpiry: now.toISOString() }],
    ["live route missing", { live: false }],
    [
      "final expiry elapsed",
      { parent: { ...parent, expiresAt: now.toISOString() } },
    ],
  ] as const)("fails closed when %s", async (_label, overrides) => {
    await expect(
      harness(overrides).activator.activate(previewId),
    ).rejects.toHaveProperty("name", "FullStackRoutingActivationError")
  })

  it.each(["localhost", "bad domain", "example.com."])(
    "rejects invalid production base domain %s",
    (baseDomain) => {
      expect(
        () =>
          new FullStackRoutingActivator({
            fullStackControlPlane: {} as FullStackPreviewControlPlane,
            artifactStore: { get: vi.fn() },
            backendControlPlane: {} as BackendRuntimeControlPlane,
            liveRuntimeResolver: { resolve: vi.fn() },
            baseDomain,
          }),
      ).toThrow(/valid registrable domain/)
    },
  )
})
