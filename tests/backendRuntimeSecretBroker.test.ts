import { describe, expect, it } from "vitest"

import { InvalidGeneratedSecretNameError } from "../core/backendSecrets/generatedSecretPolicy"
import {
  DuplicateBackendRuntimeSecretIssuanceError,
  InMemoryBackendRuntimeSecretBroker,
} from "../services/backend-runtime-worker/secretBroker"

const runtimeIdA = "runtime-aaaaaaaa"
const runtimeIdB = "runtime-bbbbbbbb"

describe("InMemoryBackendRuntimeSecretBroker", () => {
  it("issue -> take returns exactly the issued names and material", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    const issued = broker.issue(runtimeIdA, ["JWT_SECRET", "SESSION_SECRET"])
    const taken = broker.take(runtimeIdA)

    expect(taken).not.toBeNull()
    expect(taken?.runtimeId).toBe(runtimeIdA)
    expect([...(taken?.values.keys() ?? [])].sort()).toEqual([
      "JWT_SECRET",
      "SESSION_SECRET",
    ])
    expect(taken?.values.get("JWT_SECRET")?.reveal()).toBe(
      issued.values.get("JWT_SECRET")?.reveal(),
    )
  })

  it("take is destructive -- a second take returns null", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    broker.issue(runtimeIdA, ["JWT_SECRET"])

    broker.take(runtimeIdA)

    expect(broker.take(runtimeIdA)).toBeNull()
  })

  it("take without a prior issue returns null", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    expect(broker.take(runtimeIdA)).toBeNull()
  })

  it("discard before take removes the material -- the later take returns null", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    broker.issue(runtimeIdA, ["JWT_SECRET"])

    broker.discard(runtimeIdA)

    expect(broker.take(runtimeIdA)).toBeNull()
  })

  it("discard is idempotent and safe even when nothing was ever issued", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    expect(() => broker.discard(runtimeIdA)).not.toThrow()
    expect(() => broker.discard(runtimeIdA)).not.toThrow()
  })

  it("discard after take is a safe no-op", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    broker.issue(runtimeIdA, ["JWT_SECRET"])
    broker.take(runtimeIdA)

    expect(() => broker.discard(runtimeIdA)).not.toThrow()
  })

  it("fails closed on a duplicate issue for the same runtimeId rather than silently overwriting", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const first = broker.issue(runtimeIdA, ["JWT_SECRET"])

    expect(() => broker.issue(runtimeIdA, ["SESSION_SECRET"])).toThrow(
      DuplicateBackendRuntimeSecretIssuanceError,
    )

    // The original, still-unconsumed material must survive the rejected
    // second issuance untouched.
    const taken = broker.take(runtimeIdA)
    expect([...(taken?.values.keys() ?? [])]).toEqual(["JWT_SECRET"])
    expect(taken?.values.get("JWT_SECRET")?.reveal()).toBe(
      first.values.get("JWT_SECRET")?.reveal(),
    )
  })

  it("re-issuing after take/discard is allowed and produces fresh material", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const first = broker.issue(runtimeIdA, ["JWT_SECRET"])
    broker.take(runtimeIdA)

    const second = broker.issue(runtimeIdA, ["JWT_SECRET"])

    expect(second.values.get("JWT_SECRET")?.reveal()).not.toBe(
      first.values.get("JWT_SECRET")?.reveal(),
    )
  })

  it("keeps different runtime ids fully isolated from each other", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    broker.issue(runtimeIdA, ["JWT_SECRET"])
    broker.issue(runtimeIdB, ["SESSION_SECRET"])

    broker.discard(runtimeIdA)

    expect(broker.take(runtimeIdA)).toBeNull()
    const takenB = broker.take(runtimeIdB)
    expect([...(takenB?.values.keys() ?? [])]).toEqual(["SESSION_SECRET"])
  })

  it("rejects an ineligible name at issue time -- nothing is stored", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    expect(() =>
      // @ts-expect-error -- deliberately passing a name outside the fixed
      // PreviewGeneratedSecretName union to prove the broker itself
      // re-validates, not just the type system.
      broker.issue(runtimeIdA, ["APP_SECRET"]),
    ).toThrow(InvalidGeneratedSecretNameError)
    expect(broker.take(runtimeIdA)).toBeNull()
  })

  it("rejects duplicate names within one issue() call", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    expect(() =>
      broker.issue(runtimeIdA, ["JWT_SECRET", "JWT_SECRET"]),
    ).toThrow(InvalidGeneratedSecretNameError)
    expect(broker.take(runtimeIdA)).toBeNull()
  })

  it("issue with an empty name list stores material with no entries", () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()

    broker.issue(runtimeIdA, [])
    const taken = broker.take(runtimeIdA)

    expect(taken?.values.size).toBe(0)
  })

  it.each(["", "short", "has spaces", "has/slash", "a".repeat(65)])(
    "rejects a malformed runtimeId %j on issue/take/discard",
    (malformed) => {
      const broker = new InMemoryBackendRuntimeSecretBroker()

      expect(() => broker.issue(malformed, ["JWT_SECRET"])).toThrow(
        "Invalid backend runtime id.",
      )
      expect(() => broker.take(malformed)).toThrow(
        "Invalid backend runtime id.",
      )
      expect(() => broker.discard(malformed)).toThrow(
        "Invalid backend runtime id.",
      )
    },
  )

  it("a fresh broker instance (simulating a process restart) has no knowledge of material an earlier instance issued", () => {
    const before = new InMemoryBackendRuntimeSecretBroker()
    before.issue(runtimeIdA, ["JWT_SECRET"])
    // The runtimeId itself would still exist in durable/queue state after a
    // real restart (see docs/EPHEMERAL_SECRETS.md section 8) -- what must
    // never survive is the secret material, which lived only in `before`'s
    // process memory.

    const after = new InMemoryBackendRuntimeSecretBroker()

    expect(after.take(runtimeIdA)).toBeNull()
  })
})
