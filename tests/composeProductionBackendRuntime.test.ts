import { describe, expect, it } from "vitest"

import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import { composeProductionBackendRuntime } from "../services/preview-worker/gvisor/composeProductionBackendRuntime"

function fakeControlPlane(): BackendRuntimeControlPlane {
  return new BackendRuntimeControlPlane(
    { resolve: async () => null },
    new InMemoryBackendRuntimeStore(),
    new InMemoryBackendRuntimeQueue(),
  )
}

describe("composeProductionBackendRuntime", () => {
  it("returns a real BackendRuntimeSupervisor", () => {
    const supervisor = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
    })

    expect(supervisor).toBeInstanceOf(BackendRuntimeSupervisor)
  })

  it("passes an explicitly injected live-route registry instance straight through to the returned supervisor, rather than constructing its own", () => {
    const injectedRegistry = new LiveBackendRuntimeRegistry()

    const supervisor = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
      liveRuntimeRegistry: injectedRegistry,
    })

    // Pure composition-wiring proof, not a behavior test: exercising
    // BackendRuntimeSupervisor.run() through this composition means real
    // gVisor/runsc/ip/iptables invocation and real sandbox disk I/O, which
    // is out of scope for a portable test (see tests/realBackendRuntime.test.ts
    // for that coverage). Identity is asserted directly against the
    // otherwise-private field instead of driving the full lifecycle.
    expect(privateLiveRuntimeRegistryOf(supervisor)).toBe(injectedRegistry)
  })

  it("defaults to a fresh, empty live-route registry per composition when none is injected", () => {
    const supervisorA = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
    })
    const supervisorB = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
    })

    const registryA = privateLiveRuntimeRegistryOf(supervisorA)
    const registryB = privateLiveRuntimeRegistryOf(supervisorB)

    expect(registryA).toBeInstanceOf(LiveBackendRuntimeRegistry)
    expect(registryB).toBeInstanceOf(LiveBackendRuntimeRegistry)
    // Never a shared module-level singleton -- each composition call gets
    // its own registry unless the caller explicitly injects one.
    expect(registryA).not.toBe(registryB)
  })
})

function privateLiveRuntimeRegistryOf(
  supervisor: BackendRuntimeSupervisor,
): unknown {
  return (supervisor as unknown as { liveRuntimeRegistry: unknown })
    .liveRuntimeRegistry
}
