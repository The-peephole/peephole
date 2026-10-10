import { inspect } from "node:util"
import { describe, expect, it } from "vitest"

import {
  InMemoryUserEnvironmentBroker,
  UserEnvironmentAdmissionError,
  type UserEnvironmentBinding,
} from "../services/user-environment/userEnvironmentBroker"

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"
const previewId = "fullstack-11111111-2222-3333-4444-555555555555"
const runtimeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const repository = {
  repositoryId: 7,
  owner: "Acme",
  name: "Web",
  commitSha: "a".repeat(40),
}
const entries = [
  { name: "APP_GREETING", value: SENTINEL },
  { name: "FEATURE_MODE", value: "demo" },
]
const binding: UserEnvironmentBinding = {
  previewId,
  requesterId: "github:1",
  repository,
  backendSourceRoot: "backend",
  names: ["APP_GREETING", "FEATURE_MODE"],
}
const expected = {
  runtimeId,
  repository: { ...repository, owner: "acme", name: "web" },
  backendSourceRoot: "backend",
  names: ["APP_GREETING", "FEATURE_MODE"],
}

function compose(start = Date.parse("2026-10-11T00:00:00.000Z")) {
  let now = start
  const broker = new InMemoryUserEnvironmentBroker({ now: () => new Date(now) })
  return {
    broker,
    advance: (ms: number) => {
      now += ms
    },
    expiresAt: new Date(start + 60_000),
  }
}

describe("InMemoryUserEnvironmentBroker", () => {
  it("delivers exactly the registered values once, bound to the runtime id", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)

    const material = broker.take(previewId, expected)
    expect(material?.runtimeId).toBe(runtimeId)
    expect([...material!.values.keys()]).toEqual([
      "APP_GREETING",
      "FEATURE_MODE",
    ])
    expect(material!.values.get("APP_GREETING")!.reveal()).toBe(SENTINEL)

    // Single use: a retried START can never read the values again.
    expect(broker.take(previewId, expected)).toBeNull()
  })

  it.each([
    [
      "another commit",
      { repository: { ...repository, commitSha: "b".repeat(40) } },
    ],
    [
      "another repository id",
      { repository: { ...repository, repositoryId: 8 } },
    ],
    ["another owner", { repository: { ...repository, owner: "evil" } }],
    ["another backend source root", { backendSourceRoot: "api" }],
    ["fewer names", { names: ["APP_GREETING"] }],
    ["different names", { names: ["APP_GREETING", "OTHER_MODE"] }],
  ])("fails closed and destroys the values for %s", (_label, override) => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(broker.take(previewId, { ...expected, ...override })).toBeNull()
    // The rightful caller cannot recover them afterwards either.
    expect(broker.take(previewId, expected)).toBeNull()
  })

  it("never delivers values registered for another preview", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(
      broker.take("fullstack-99999999-2222-3333-4444-555555555555", expected),
    ).toBeNull()
    expect(broker.take(previewId, expected)).not.toBeNull()
  })

  it("rejects an invalid runtime id without consuming", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(
      broker.take(previewId, { ...expected, runtimeId: "../x" }),
    ).toBeNull()
    expect(broker.take(previewId, expected)).not.toBeNull()
  })

  it("expires unconsumed values at the retention deadline", () => {
    const { broker, advance, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    advance(60_000)
    expect(broker.take(previewId, expected)).toBeNull()
    expect(broker.compare(previewId, "github:1", entries)).toBe("unknown")
  })

  it("discard is idempotent and removes values and replay digest", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    broker.discard(previewId)
    broker.discard(previewId)
    expect(broker.take(previewId, expected)).toBeNull()
    expect(broker.compare(previewId, "github:1", entries)).toBe("unknown")
  })

  it("compares replays by keyed digest, also after consumption, per requester", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(broker.compare(previewId, "github:1", [...entries].reverse())).toBe(
      "same",
    )
    expect(
      broker.compare(previewId, "github:1", [
        { name: "APP_GREETING", value: "changed" },
        entries[1]!,
      ]),
    ).toBe("different")
    // Another requester learns nothing about this preview's values.
    expect(broker.compare(previewId, "github:2", entries)).toBe("unknown")

    broker.take(previewId, expected)
    expect(broker.compare(previewId, "github:1", entries)).toBe("same")
  })

  it("uses an independent random digest key per process instance", () => {
    const first = compose()
    const second = compose()
    first.broker.register(binding, entries, first.expiresAt)
    // A fresh instance (a restarted process) has no record at all.
    expect(second.broker.compare(previewId, "github:1", entries)).toBe(
      "unknown",
    )
  })

  it.each([
    ["an invalid preview id", { ...binding, previewId: "job-1" }, entries],
    ["no names", { ...binding, names: [] }, []],
    ["an empty requester", { ...binding, requesterId: "" }, entries],
    ["mismatched names", binding, entries.slice(0, 1)],
    ["names in a different order", binding, [entries[1]!, entries[0]!]],
  ])("refuses to register %s", (_label, candidate, candidateEntries) => {
    const { broker, expiresAt } = compose()
    expect(() =>
      broker.register(candidate, candidateEntries, expiresAt),
    ).toThrow(UserEnvironmentAdmissionError)
  })

  it("refuses a duplicate registration and a past deadline", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(() => broker.register(binding, entries, expiresAt)).toThrow(
      UserEnvironmentAdmissionError,
    )
    expect(() =>
      broker.register(
        {
          ...binding,
          previewId: "fullstack-22222222-2222-3333-4444-555555555555",
        },
        entries,
        new Date("2026-10-10T00:00:00.000Z"),
      ),
    ).toThrow(UserEnvironmentAdmissionError)
  })

  it("bounds retained entries across requesters", () => {
    let now = 0
    const broker = new InMemoryUserEnvironmentBroker({
      now: () => new Date(now),
      maxEntries: 2,
    })
    const register = (suffix: string) =>
      broker.register(
        {
          ...binding,
          previewId: `fullstack-${suffix}-2222-3333-4444-555555555555`,
        },
        entries,
        new Date(now + 1_000),
      )
    register("11111111")
    register("22222222")
    expect(() => register("33333333")).toThrow(UserEnvironmentAdmissionError)
    now = 1_000
    // Expired entries free capacity again.
    expect(() => register("33333333")).not.toThrow()
  })

  it("never exposes values through serialization or inspection", () => {
    const { broker, expiresAt } = compose()
    broker.register(binding, entries, expiresAt)
    expect(JSON.stringify(broker)).not.toContain(SENTINEL)
    expect(inspect(broker, { depth: 10 })).not.toContain(SENTINEL)
    const material = broker.take(previewId, expected)!
    expect(JSON.stringify(material)).not.toContain(SENTINEL)
    expect(inspect(material, { depth: 10 })).not.toContain(SENTINEL)
    expect(String(material.values.get("APP_GREETING"))).not.toContain(SENTINEL)
  })
})
