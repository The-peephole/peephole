import { describe, expect, it } from "vitest"

import {
  ConflictingLiveBackendRuntimeRouteError,
  LiveBackendRuntimeRegistry,
} from "../services/backend-runtime-worker/liveRuntimeRegistry"

const runtimeIdA = "runtime-aaaaaaaa"
const runtimeIdB = "runtime-bbbbbbbb"
const targetA = { host: "10.201.7.2", port: 3000 }
const targetB = { host: "10.201.7.6", port: 3000 }

describe("LiveBackendRuntimeRegistry", () => {
  it("resolves a registered target by runtimeId", () => {
    const registry = new LiveBackendRuntimeRegistry()

    registry.register(runtimeIdA, targetA)

    expect(registry.resolve(runtimeIdA)).toEqual(targetA)
  })

  it("returns undefined for a runtimeId that was never registered", () => {
    const registry = new LiveBackendRuntimeRegistry()

    expect(registry.resolve(runtimeIdA)).toBeUndefined()
  })

  it("returns undefined after unregister", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)

    registry.unregister(runtimeIdA)

    expect(registry.resolve(runtimeIdA)).toBeUndefined()
  })

  it("unregister is idempotent -- repeated calls are safe and never throw", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)
    registry.unregister(runtimeIdA)

    expect(() => registry.unregister(runtimeIdA)).not.toThrow()
    expect(() => registry.unregister(runtimeIdA)).not.toThrow()
    expect(registry.resolve(runtimeIdA)).toBeUndefined()
  })

  it("unregistering a runtimeId that was never registered is a safe no-op", () => {
    const registry = new LiveBackendRuntimeRegistry()

    expect(() => registry.unregister(runtimeIdA)).not.toThrow()
  })

  it("keeps different runtime ids fully isolated from each other", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)
    registry.register(runtimeIdB, targetB)

    expect(registry.resolve(runtimeIdA)).toEqual(targetA)
    expect(registry.resolve(runtimeIdB)).toEqual(targetB)

    registry.unregister(runtimeIdA)

    expect(registry.resolve(runtimeIdA)).toBeUndefined()
    expect(registry.resolve(runtimeIdB)).toEqual(targetB)
  })

  it("registering the exact same target again for an already-registered runtimeId is idempotent", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)

    expect(() =>
      registry.register(runtimeIdA, { host: targetA.host, port: targetA.port }),
    ).not.toThrow()
    expect(registry.resolve(runtimeIdA)).toEqual(targetA)
  })

  it("rejects registering a different target for an already-registered runtimeId", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)

    expect(() => registry.register(runtimeIdA, targetB)).toThrow(
      ConflictingLiveBackendRuntimeRouteError,
    )
    // The original registration must survive a rejected conflicting write.
    expect(registry.resolve(runtimeIdA)).toEqual(targetA)
  })

  it("a resolved target cannot be used to mutate registry state", () => {
    const registry = new LiveBackendRuntimeRegistry()
    registry.register(runtimeIdA, targetA)

    const resolved = registry.resolve(runtimeIdA)
    expect(resolved).toBeDefined()
    expect(() => {
      ;(resolved as { host: string }).host = "10.0.0.99"
    }).toThrow()

    // Whether or not the mutation attempt threw, the registry's own state
    // must be provably unaffected by it.
    expect(registry.resolve(runtimeIdA)).toEqual(targetA)
  })

  it.each(["", "short", "has spaces", "has/slash", "a".repeat(65)])(
    "rejects a malformed runtimeId %j on register/unregister/resolve",
    (malformed) => {
      const registry = new LiveBackendRuntimeRegistry()

      expect(() => registry.register(malformed, targetA)).toThrow(
        "Invalid backend runtime id.",
      )
      expect(() => registry.unregister(malformed)).toThrow(
        "Invalid backend runtime id.",
      )
      expect(() => registry.resolve(malformed)).toThrow(
        "Invalid backend runtime id.",
      )
    },
  )

  it("peer-IP reuse: an unregistered runtime's old address never resolves again, even once a different runtime is registered at the same address", () => {
    const registry = new LiveBackendRuntimeRegistry()
    const sharedAddress = { host: "10.201.7.9", port: 3000 }

    // Runtime A is allocated the address, then torn down (its own
    // namespace/peerIp released back to the host for reuse).
    registry.register(runtimeIdA, sharedAddress)
    registry.unregister(runtimeIdA)

    // A completely different runtime B is later allocated the exact same
    // address by the host's subnet allocator (a legitimate, expected
    // recycling of a freed /30 slot).
    registry.register(runtimeIdB, sharedAddress)

    // Runtime A's id must never resolve again -- not to nothing-in-particular,
    // and never, under any circumstance, to B's registration.
    expect(registry.resolve(runtimeIdA)).toBeUndefined()
    expect(registry.resolve(runtimeIdB)).toEqual(sharedAddress)
  })
})
