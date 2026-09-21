import { describe, expect, it, vi } from "vitest"

import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import type { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import { createProductionFullStackRoutingInfrastructure } from "../services/production/fullStackRoutingInfrastructure"
import type { ProductionArtifactStore } from "../services/preview-api/postgres/productionArtifactStore"
import { composeProductionBackendRuntime } from "../services/preview-worker/gvisor/composeProductionBackendRuntime"

describe("production full-stack composition", () => {
  it("shares exactly one registry and one routing store across every routing participant", () => {
    const artifactStore = {
      get: vi.fn(),
      upsertMaxExpiry: vi.fn(),
      listExpired: vi.fn(),
      deleteIfStillExpired: vi.fn(),
    } as unknown as ProductionArtifactStore
    const infrastructure = createProductionFullStackRoutingInfrastructure({
      database: { query: vi.fn() } as never,
      artifactStore,
      artifactStorageDir: "C:/portable-test-artifacts",
      artifactPort: 8788,
      artifactTlsAskPort: 8790,
      artifactBaseDomain: "peepholeusercontent.dev",
      trustedAppOrigin: "https://app.peephole.dev",
    })
    const backendControlPlane = new BackendRuntimeControlPlane(
      { resolve: async () => null },
      new InMemoryBackendRuntimeStore(),
      new InMemoryBackendRuntimeQueue(),
    )
    const backendSupervisor = composeProductionBackendRuntime(
      backendControlPlane,
      {
        baseRootfsImage: "/portable-test-rootfs",
        liveRuntimeRegistry: infrastructure.liveRuntimeRegistry,
      },
    )
    const activator = infrastructure.createActivator(
      {} as FullStackPreviewControlPlane,
      backendControlPlane,
    )

    const hostRouting = (
      infrastructure.artifactHost as unknown as {
        fullStackRouting: {
          store: unknown
          liveRuntimeResolver: unknown
          backendProxy: unknown
        }
      }
    ).fullStackRouting
    const tlsRouting = (
      infrastructure.tlsAskServer as unknown as {
        options: { fullStackRouting: { store: unknown } }
      }
    ).options.fullStackRouting
    const activatorOptions = (
      activator as unknown as {
        options: { liveRuntimeResolver: unknown }
      }
    ).options

    expect(hostRouting.liveRuntimeResolver).toBe(
      infrastructure.liveRuntimeRegistry,
    )
    expect(activatorOptions.liveRuntimeResolver).toBe(
      infrastructure.liveRuntimeRegistry,
    )
    expect(hostRouting.store).toBe(infrastructure.routingStore)
    expect(tlsRouting.store).toBe(infrastructure.routingStore)
    expect(hostRouting.backendProxy).toBe(infrastructure.backendProxy)
    expect(
      (
        backendSupervisor as unknown as {
          liveRuntimeRegistry: unknown
        }
      ).liveRuntimeRegistry,
    ).toBe(infrastructure.liveRuntimeRegistry)

    infrastructure.liveRuntimeRegistry.register("runtime-shared", {
      host: "10.0.0.2",
      port: 3000,
    })
    expect(
      (
        hostRouting.liveRuntimeResolver as typeof infrastructure.liveRuntimeRegistry
      ).resolve("runtime-shared"),
    ).toEqual({ host: "10.0.0.2", port: 3000 })
  })
})
