import type { BackendRuntimeDialTarget } from "./ports"

// Matches the exact runtimeId syntax already enforced by
// BackendRuntimeControlPlane.getOwnedRuntime (controlPlane.ts) and the
// backend-runtime HTTP route (http.ts) -- deliberately re-validated here
// too, since this registry has its own, independent trust boundary.
const RUNTIME_ID_PATTERN = /^[a-z\d-]{8,64}$/i

export interface LiveBackendRuntimeRouteResolver {
  /** The only valid lookup key is a server-minted runtimeId -- there is no
   * lookup by host/IP and no "any running backend" fallback. Returns a
   * frozen copy, never the internally stored object, so a caller can never
   * mutate registry state through a resolved value. */
  resolve(runtimeId: string): BackendRuntimeDialTarget | undefined
}

export interface LiveBackendRuntimeRouteRegistry extends LiveBackendRuntimeRouteResolver {
  register(runtimeId: string, target: BackendRuntimeDialTarget): void
  unregister(runtimeId: string): void
}

/** Thrown when `register()` is called for a runtimeId that already has a
 * live route pointing at a *different* target -- this only happens if a
 * caller's own lifecycle invariant is already broken (e.g. registering
 * twice without unregistering), so this fails loudly rather than silently
 * overwriting a route a still-live process might be relying on. */
export class ConflictingLiveBackendRuntimeRouteError extends Error {
  constructor(runtimeId: string) {
    super(
      `A different live route is already registered for backend runtime ${runtimeId}.`,
    )
    this.name = "ConflictingLiveBackendRuntimeRouteError"
  }
}

/**
 * Process-local, in-memory-only map from a running backend runtime's
 * server-minted id to the trusted sandbox coordinates a same-process proxy
 * may dial. Never persisted, never serialized, never exposed over HTTP --
 * see `BackendRuntimeDialTarget`'s doc comment in ports.ts.
 *
 * Starts empty every process start, and stays that way by design: after a
 * restart no `runtimeId` in this registry could possibly still be live
 * (backend-v1's own store/queue are equally process-lifetime-only), and an
 * ingress-only sandbox's `peerIp` slot can be reused by a *different*,
 * unrelated later sandbox once its namespace is released -- reconstructing
 * this registry from any durable record would risk resolving a stale
 * runtimeId to whichever new sandbox happens to have been allocated the
 * same address. See `BackendRuntimeSupervisor`'s registration/teardown
 * ordering for how staleness is actually prevented instead: unregister
 * always happens before the namespace that owned the address is released.
 */
export class LiveBackendRuntimeRegistry implements LiveBackendRuntimeRouteRegistry {
  private readonly targets = new Map<string, BackendRuntimeDialTarget>()

  register(runtimeId: string, target: BackendRuntimeDialTarget): void {
    assertValidRuntimeId(runtimeId)
    const existing = this.targets.get(runtimeId)
    if (existing) {
      if (existing.host === target.host && existing.port === target.port) {
        // Idempotent: registering the exact same target again is a safe
        // retry, not a conflict.
        return
      }
      throw new ConflictingLiveBackendRuntimeRouteError(runtimeId)
    }
    this.targets.set(
      runtimeId,
      Object.freeze({ host: target.host, port: target.port }),
    )
  }

  unregister(runtimeId: string): void {
    assertValidRuntimeId(runtimeId)
    this.targets.delete(runtimeId)
  }

  resolve(runtimeId: string): BackendRuntimeDialTarget | undefined {
    assertValidRuntimeId(runtimeId)
    const target = this.targets.get(runtimeId)
    return target
      ? Object.freeze({ host: target.host, port: target.port })
      : undefined
  }
}

function assertValidRuntimeId(runtimeId: string): void {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new Error("Invalid backend runtime id.")
  }
}
