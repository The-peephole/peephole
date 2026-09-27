import { assertValidGeneratedSecretNames } from "../../core/backendSecrets/generatedSecretPolicy"
import { generatePreviewSecretValue } from "../../core/backendSecrets/generatedSecretValue"
import type {
  GeneratedSecretMaterial,
  OpaqueSecretValue,
  PreviewGeneratedSecretName,
} from "../../types/backendRuntimeSecrets"

// Matches the exact runtimeId syntax already enforced by
// BackendRuntimeControlPlane.getOwnedRuntime (controlPlane.ts) and
// LiveBackendRuntimeRegistry (liveRuntimeRegistry.ts) -- re-validated here
// too, since this broker has its own, independent trust boundary.
const RUNTIME_ID_PATTERN = /^[a-z\d-]{8,64}$/i

/** Thrown when `issue()` is called twice for the same `runtimeId` without an
 * intervening `take()`/`discard()` -- this only happens if a caller's own
 * lifecycle invariant is already broken, so this fails loudly rather than
 * silently overwriting still-unconsumed material a live process might be
 * about to read. */
export class DuplicateBackendRuntimeSecretIssuanceError extends Error {
  constructor(runtimeId: string) {
    super(
      `Secret material was already issued for backend runtime ${runtimeId}.`,
    )
    this.name = "DuplicateBackendRuntimeSecretIssuanceError"
  }
}

export interface BackendRuntimeSecretBroker {
  /** Generates fresh material for exactly `names` and stores it under
   * `runtimeId`. Throws `InvalidGeneratedSecretNameError` if any name is
   * ineligible or duplicated, and `DuplicateBackendRuntimeSecretIssuanceError`
   * if this `runtimeId` already has unconsumed material. */
  issue(
    runtimeId: string,
    names: readonly PreviewGeneratedSecretName[],
  ): GeneratedSecretMaterial
  /** Single-consumer read-then-delete. Returns `null` if nothing was ever
   * issued for this `runtimeId`, it was already taken, or it was
   * discarded -- callers must fail closed on `null`, never fall back to
   * starting without secrets. */
  take(runtimeId: string): GeneratedSecretMaterial | null
  /** Idempotent; safe to call even if nothing was ever issued. */
  discard(runtimeId: string): void
}

/**
 * Process-local, in-memory-only map from a backend runtime's server-minted
 * id to its not-yet-consumed generated secret material. Never persisted,
 * never serialized, never exposed over HTTP -- mirrors
 * `LiveBackendRuntimeRegistry` (`liveRuntimeRegistry.ts`) exactly, the same
 * architectural precedent docs/EPHEMERAL_SECRETS.md section 8 names.
 *
 * M10-C2 wires this interface into `BackendRuntimeSupervisor`; M10-C3 makes
 * one explicitly-owned instance production-reachable for canonical
 * exact-commit plans. It remains process-local and non-durable; real-host
 * verification and deployment remain pending.
 *
 * Starts empty every process start, and stays that way by design: a
 * restart must never let previously issued-but-unconsumed material survive
 * to be handed to a different attempt (see docs/EPHEMERAL_SECRETS.md
 * section 8's restart-behavior discussion) -- a fresh instance simply has
 * no knowledge of anything an earlier instance held.
 */
export class InMemoryBackendRuntimeSecretBroker implements BackendRuntimeSecretBroker {
  private readonly material = new Map<string, GeneratedSecretMaterial>()

  issue(
    runtimeId: string,
    names: readonly PreviewGeneratedSecretName[],
  ): GeneratedSecretMaterial {
    assertValidRuntimeId(runtimeId)
    const validated = assertValidGeneratedSecretNames(names)
    if (this.material.has(runtimeId)) {
      throw new DuplicateBackendRuntimeSecretIssuanceError(runtimeId)
    }

    const values = new Map<PreviewGeneratedSecretName, OpaqueSecretValue>()
    for (const name of validated) {
      values.set(name, generatePreviewSecretValue())
    }
    const issued: GeneratedSecretMaterial = { runtimeId, values }
    this.material.set(runtimeId, issued)
    return issued
  }

  take(runtimeId: string): GeneratedSecretMaterial | null {
    assertValidRuntimeId(runtimeId)
    const existing = this.material.get(runtimeId)
    if (!existing) return null
    this.material.delete(runtimeId)
    return existing
  }

  discard(runtimeId: string): void {
    assertValidRuntimeId(runtimeId)
    this.material.delete(runtimeId)
  }
}

function assertValidRuntimeId(runtimeId: string): void {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new Error("Invalid backend runtime id.")
  }
}
