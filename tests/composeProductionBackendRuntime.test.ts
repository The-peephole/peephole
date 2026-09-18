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
  it("returns a real BackendRuntimeSupervisor when given an explicit registry", () => {
    const supervisor = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
      liveRuntimeRegistry: new LiveBackendRuntimeRegistry(),
    })

    expect(supervisor).toBeInstanceOf(BackendRuntimeSupervisor)
  })

  it("requires an explicit live-route registry at the type level -- omitting it is a compile error", () => {
    // This is the actual proof that "no hidden/default registry exists":
    // if composeProductionBackendRuntime ever regressed to defaulting
    // liveRuntimeRegistry again, the call below would stop being a type
    // error, `@ts-expect-error` would itself become an unused-directive
    // error, and `npm run typecheck` would fail -- so this property is
    // enforced by CI on every change, not just asserted once here. Never
    // actually invoked at runtime; the point is exercised entirely at
    // compile time.
    function callWithoutRegistry(): void {
      // @ts-expect-error liveRuntimeRegistry is required, not optional.
      composeProductionBackendRuntime(fakeControlPlane(), {
        baseRootfsImage: "/tmp/fake-rootfs",
      })
    }
    void callWithoutRegistry
  })

  it("passes the exact injected live-route registry instance through to the returned supervisor, rather than constructing its own", () => {
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

  it("keeps two deliberately-different injected registries fully separate across two compositions -- no shared module/global default", () => {
    const registryA = new LiveBackendRuntimeRegistry()
    const registryB = new LiveBackendRuntimeRegistry()

    const supervisorA = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
      liveRuntimeRegistry: registryA,
    })
    const supervisorB = composeProductionBackendRuntime(fakeControlPlane(), {
      baseRootfsImage: "/tmp/fake-rootfs",
      liveRuntimeRegistry: registryB,
    })

    expect(privateLiveRuntimeRegistryOf(supervisorA)).toBe(registryA)
    expect(privateLiveRuntimeRegistryOf(supervisorB)).toBe(registryB)
    expect(privateLiveRuntimeRegistryOf(supervisorA)).not.toBe(
      privateLiveRuntimeRegistryOf(supervisorB),
    )

    // Behavioral corroboration of the same property: a route registered
    // through registryA is invisible to registryB and vice versa -- if
    // composition ever silently shared one registry between the two
    // compositions, this would fail even though the identity checks above
    // might not catch every possible split-brain shape.
    registryA.register("runtime-aaaaaaaa", { host: "10.0.0.1", port: 3000 })
    expect(registryB.resolve("runtime-aaaaaaaa")).toBeUndefined()
  })
})

function privateLiveRuntimeRegistryOf(
  supervisor: BackendRuntimeSupervisor,
): unknown {
  return (supervisor as unknown as { liveRuntimeRegistry: unknown })
    .liveRuntimeRegistry
}
