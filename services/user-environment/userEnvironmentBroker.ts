import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { createOpaqueSecretValue } from "../../core/backendSecrets/generatedSecretValue"
import type { OpaqueSecretValue } from "../../types/backendRuntimeSecrets"
import type { PreviewRepositoryRef } from "../../types/preview"
import type {
  UserEnvironmentEntry,
  UserEnvironmentMaterial,
} from "../../types/userEnvironment"

const PREVIEW_ID_PATTERN = /^fullstack-[a-z\d-]{8,64}$/i
const RUNTIME_ID_PATTERN = /^[a-z\d-]{8,64}$/i

/** The authoritative identity a submission was admitted for. Every field
 * is server-derived at admission: the requester from the verified session,
 * the preview id freshly minted, and the names from the server's own
 * exact-commit re-derivation -- never from the client's list. */
export interface UserEnvironmentBinding {
  previewId: string
  requesterId: string
  repository: PreviewRepositoryRef
  backendSourceRoot: string
  names: readonly string[]
}

export type UserEnvironmentReplayMatch = "same" | "different" | "unknown"

export class UserEnvironmentAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserEnvironmentAdmissionError"
  }
}

/** The backend worker's only view: destructive, binding-checked take. */
export interface UserEnvironmentSource {
  /** Returns the values exactly once, and only when `expected` matches the
   * admitted binding; `null` otherwise. Callers must fail closed on `null`
   * -- never start without the values. A mismatch also destroys them. */
  take(
    previewId: string,
    expected: {
      runtimeId: string
      repository: PreviewRepositoryRef
      backendSourceRoot: string
      names: readonly string[]
    },
  ): UserEnvironmentMaterial | null
  /** Idempotent. */
  discard(previewId: string): void
}

export interface UserEnvironmentBroker extends UserEnvironmentSource {
  /** Throws `UserEnvironmentAdmissionError` for a malformed binding, a
   * names mismatch, a duplicate preview id, or a full broker. */
  register(
    binding: UserEnvironmentBinding,
    entries: readonly UserEnvironmentEntry[],
    expiresAt: Date,
  ): void
  /** Idempotent-replay check. `unknown` when nothing is retained for this
   * preview and requester (never registered, discarded, expired, or the
   * process restarted) -- the caller cannot tell and must not guess. */
  compare(
    previewId: string,
    requesterId: string,
    entries: readonly UserEnvironmentEntry[],
  ): UserEnvironmentReplayMatch
}

export interface InMemoryUserEnvironmentBrokerOptions {
  now?: () => Date
  /** Bounds retained process memory across all requesters. */
  maxEntries?: number
}

interface RetainedEntry {
  binding: UserEnvironmentBinding
  /** Null once taken; the digest stays for replay comparison only. */
  values: ReadonlyMap<string, OpaqueSecretValue> | null
  digest: Buffer
  expiresAtMs: number
}

/**
 * Process-local, in-memory-only holder of user-provided configuration from
 * full-stack admission until the backend runtime's START boundary --
 * modeled on M10's `InMemoryBackendRuntimeSecretBroker` and the
 * `LiveBackendRuntimeRouteRegistry` precedent. Never persisted, never
 * serialized, never exposed over HTTP. A fresh process starts empty, so a
 * restart can only make a queued preview fail closed
 * (`CONFIGURATION_UNAVAILABLE`), never run with stale or default values.
 *
 * Replay comparison uses HMAC-SHA-256 under a random key generated per
 * broker instance and never exported, so the retained digest is neither
 * durable nor an offline-guessable hash of a low-entropy value
 * (docs/EPHEMERAL_SECRETS.md section 11's forward note).
 */
export class InMemoryUserEnvironmentBroker implements UserEnvironmentBroker {
  private readonly entries = new Map<string, RetainedEntry>()
  private readonly digestKey = randomBytes(32)
  private readonly now: () => Date
  private readonly maxEntries: number

  constructor(options: InMemoryUserEnvironmentBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.maxEntries = options.maxEntries ?? 256
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("User environment broker capacity must be positive.")
    }
  }

  register(
    binding: UserEnvironmentBinding,
    entries: readonly UserEnvironmentEntry[],
    expiresAt: Date,
  ): void {
    this.sweep()
    if (!PREVIEW_ID_PATTERN.test(binding.previewId)) {
      throw new UserEnvironmentAdmissionError("Invalid preview identity.")
    }
    if (!binding.requesterId || binding.names.length === 0) {
      throw new UserEnvironmentAdmissionError("Invalid admission binding.")
    }
    if (
      entries.length !== binding.names.length ||
      entries.some((entry, index) => entry.name !== binding.names[index])
    ) {
      throw new UserEnvironmentAdmissionError(
        "Submitted names do not match the admitted names.",
      )
    }
    const expiresAtMs = expiresAt.getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime()) {
      throw new UserEnvironmentAdmissionError("Invalid retention deadline.")
    }
    if (this.entries.has(binding.previewId)) {
      throw new UserEnvironmentAdmissionError(
        "Configuration is already registered for this preview.",
      )
    }
    if (this.entries.size >= this.maxEntries) {
      throw new UserEnvironmentAdmissionError(
        "Too many previews are waiting for configuration delivery.",
      )
    }

    const values = new Map<string, OpaqueSecretValue>()
    for (const entry of entries) {
      values.set(entry.name, createOpaqueSecretValue(entry.value))
    }
    this.entries.set(binding.previewId, {
      binding: Object.freeze({
        ...binding,
        repository: Object.freeze({ ...binding.repository }),
        names: Object.freeze([...binding.names]),
      }),
      values,
      digest: this.digest(entries),
      expiresAtMs,
    })
  }

  compare(
    previewId: string,
    requesterId: string,
    entries: readonly UserEnvironmentEntry[],
  ): UserEnvironmentReplayMatch {
    this.sweep()
    const retained = this.entries.get(previewId)
    if (!retained || retained.binding.requesterId !== requesterId) {
      return "unknown"
    }
    return timingSafeEqual(retained.digest, this.digest(entries))
      ? "same"
      : "different"
  }

  take(
    previewId: string,
    expected: Parameters<UserEnvironmentSource["take"]>[1],
  ): UserEnvironmentMaterial | null {
    this.sweep()
    if (!RUNTIME_ID_PATTERN.test(expected.runtimeId)) return null
    const retained = this.entries.get(previewId)
    if (!retained?.values) return null

    const values = retained.values
    // Consumed whether or not the binding matches: a mismatched caller
    // must not be able to retry, and the rightful one fails closed.
    retained.values = null
    const { binding } = retained
    if (
      binding.backendSourceRoot !== expected.backendSourceRoot ||
      !sameRepository(binding.repository, expected.repository) ||
      binding.names.length !== expected.names.length ||
      binding.names.some((name, index) => name !== expected.names[index]) ||
      values.size !== binding.names.length
    ) {
      return null
    }
    return Object.freeze({ runtimeId: expected.runtimeId, values })
  }

  discard(previewId: string): void {
    this.entries.delete(previewId)
  }

  private sweep(): void {
    const nowMs = this.now().getTime()
    for (const [previewId, retained] of this.entries) {
      if (retained.expiresAtMs <= nowMs) this.entries.delete(previewId)
    }
  }

  private digest(entries: readonly UserEnvironmentEntry[]): Buffer {
    const canonical = JSON.stringify(
      [...entries]
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        )
        .map((entry) => [entry.name, entry.value]),
    )
    return createHmac("sha256", this.digestKey).update(canonical).digest()
  }
}

function sameRepository(
  left: PreviewRepositoryRef,
  right: PreviewRepositoryRef,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}
