import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import { createFullStackPreviewHttpHandler } from "../services/fullstack-preview-api/http"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { PreviewSessionAuth } from "../services/preview-api/previewSessionAuth"
import { PreviewSessionIssuer } from "../services/preview-api/previewSession"
import {
  startNodePreviewApi,
  type RunningNodePreviewApi,
} from "../services/preview-api/startNodeServer"
import { InMemoryUserEnvironmentBroker } from "../services/user-environment/userEnvironmentBroker"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type { UserEnvironmentEntry } from "../types/userEnvironment"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
  validBackendPlan,
  validFrontendPlan,
} from "./support/fakeFullStackPreview"

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"
const requester = { subject: "github:1", ip: "203.0.113.10" }
const otherRequester = { subject: "github:2", ip: "203.0.113.20" }
const idempotencyKey = "request-key-0123456789abcdef"
const previewIds = [
  "fullstack-00000000-0000-0000-0000-000000000001",
  "fullstack-00000000-0000-0000-0000-000000000002",
  "fullstack-00000000-0000-0000-0000-000000000003",
]
const runtimeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const configurablePlan: BackendRuntimePlan = {
  ...validBackendPlan,
  userEnvironmentNames: ["APP_GREETING", "FEATURE_MODE"],
}
const entries: UserEnvironmentEntry[] = [
  { name: "APP_GREETING", value: SENTINEL },
  { name: "FEATURE_MODE", value: "demo" },
]

function request(userEnvironment?: UserEnvironmentEntry[]) {
  return {
    contractVersion: "fullstack-v1" as const,
    repository,
    frontendTarget: { sourceRoot: "frontend" },
    backendSourceRoot: "backend",
    ...(userEnvironment ? { userEnvironment } : {}),
  }
}

function compose(options: { broker?: boolean } = {}) {
  const store = new FakeFullStackPreviewStore()
  const queue = new FakeFullStackPreviewQueue()
  const backendResolver = new FakeBackendPlanResolver()
  backendResolver.nextPlan = configurablePlan
  const broker =
    options.broker === false
      ? undefined
      : new InMemoryUserEnvironmentBroker({
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        })
  let nextId = 0
  const controlPlane = new FullStackPreviewControlPlane(
    new FakeFrontendPlanResolver(),
    backendResolver,
    store,
    queue,
    { consume: async () => ({ allowed: true as const }) },
    {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      createId: () => previewIds[nextId++]!,
      userEnvironmentBroker: broker,
    },
  )
  const take = (previewId = previewIds[0]!) =>
    broker!.take(previewId, {
      runtimeId,
      repository,
      backendSourceRoot: "backend",
      names: configurablePlan.userEnvironmentNames,
    })
  return { controlPlane, store, queue, backendResolver, broker, take }
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; status?: number }
  }
  throw new Error("Expected the promise to reject.")
}

describe("full-stack admission of user-provided configuration", () => {
  it("admits exactly the server-derived names and hands the values to the broker", async () => {
    const { controlPlane, store, queue, take } = compose()
    const result = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )

    expect(result.created).toBe(true)
    const material = take(result.preview.id)
    expect(material?.values.get("APP_GREETING")?.reveal()).toBe(SENTINEL)

    // Non-leakage: response, durable record, queue payload, fingerprint.
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    const stored = await store.get(result.preview.id)
    expect(JSON.stringify(stored)).not.toContain(SENTINEL)
    expect(JSON.stringify(stored)).not.toContain("demo")
    expect(JSON.stringify(queue.enqueued)).not.toContain(SENTINEL)
    expect(stored?.requestFingerprint).toMatch(/^[a-f\d]{64}$/)
  })

  it("keeps every pre-M12 request fingerprint identical", async () => {
    const legacy = compose({ broker: false })
    legacy.backendResolver.nextPlan = validBackendPlan
    const withEmpty = compose({ broker: false })
    withEmpty.backendResolver.nextPlan = validBackendPlan
    const a = await legacy.controlPlane.create(
      request(),
      idempotencyKey,
      requester,
    )
    const b = await withEmpty.controlPlane.create(
      request([]),
      idempotencyKey,
      requester,
    )
    expect((await legacy.store.get(a.preview.id))?.requestFingerprint).toBe(
      (await withEmpty.store.get(b.preview.id))?.requestFingerprint,
    )
  })

  it("fingerprints names but never values", async () => {
    const first = compose()
    const second = compose()
    const a = await first.controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    const b = await second.controlPlane.create(
      request([
        { name: "APP_GREETING", value: "something else" },
        { name: "FEATURE_MODE", value: "other" },
      ]),
      idempotencyKey,
      requester,
    )
    expect((await first.store.get(a.preview.id))?.requestFingerprint).toBe(
      (await second.store.get(b.preview.id))?.requestFingerprint,
    )
  })

  it("rejects a configurable backend when this server does not accept configuration", async () => {
    const { controlPlane, store } = compose({ broker: false })
    const withValues = await errorOf(
      controlPlane.create(request(entries), idempotencyKey, requester),
    )
    expect(withValues).toMatchObject({
      code: "UNSUPPORTED_BACKEND",
      status: 422,
    })
    const withoutValues = await errorOf(
      controlPlane.create(request(), `${idempotencyKey}-2`, requester),
    )
    expect(withoutValues).toMatchObject({ code: "UNSUPPORTED_BACKEND" })
    expect(await store.listAll()).toEqual([])
  })

  it.each([
    [
      "a missing value",
      entries.slice(0, 1),
      /A value for FEATURE_MODE is required/,
    ],
    [
      "an undeclared name",
      [...entries, { name: "EXTRA_MODE", value: "x" }],
      /EXTRA_MODE is not a user-configurable variable/,
    ],
    ["no values at all", undefined, /A value for APP_GREETING is required/],
  ])(
    "rejects %s before anything is persisted",
    async (_label, values, message) => {
      const { controlPlane, store, take } = compose()
      const error = await errorOf(
        controlPlane.create(request(values), idempotencyKey, requester),
      )
      expect(error).toMatchObject({ code: "INVALID_REQUEST", status: 400 })
      expect(error.message).toMatch(message)
      expect(error.message).not.toContain(SENTINEL)
      expect(await store.listAll()).toEqual([])
      expect(take()).toBeNull()
    },
  )

  it("rejects values for a backend that declares no configuration", async () => {
    const { controlPlane, backendResolver } = compose()
    backendResolver.nextPlan = validBackendPlan
    await expect(
      controlPlane.create(request(entries), idempotencyKey, requester),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })

  it("replays the same key and values without re-registering", async () => {
    const { controlPlane, take } = compose()
    const first = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    const replay = await controlPlane.create(
      request([...entries].reverse()),
      idempotencyKey,
      requester,
    )
    expect(replay).toEqual({ created: false, preview: first.preview })
    expect(take(first.preview.id)).not.toBeNull()
  })

  it("rejects the same key with different values as a conflict, also after consumption", async () => {
    const { controlPlane, take } = compose()
    const first = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    const changed = [{ ...entries[0]!, value: "changed" }, entries[1]!]
    await expect(
      controlPlane.create(request(changed), idempotencyKey, requester),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })

    take(first.preview.id)
    await expect(
      controlPlane.create(request(changed), idempotencyKey, requester),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    // The original values are never replaced.
  })

  it("rejects the same key with a different set of names as a conflict", async () => {
    const { controlPlane } = compose()
    await controlPlane.create(request(entries), idempotencyKey, requester)
    await expect(
      controlPlane.create(
        request(entries.slice(0, 1)),
        idempotencyKey,
        requester,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("keeps replay behavior when nothing is retained (restart, expiry, discard)", async () => {
    const { controlPlane, broker } = compose()
    const first = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    broker!.discard(first.preview.id)
    const replay = await controlPlane.create(
      request([{ ...entries[0]!, value: "changed" }, entries[1]!]),
      idempotencyKey,
      requester,
    )
    expect(replay.created).toBe(false)
  })

  it("isolates requesters: another user's key space never reaches these values", async () => {
    const { controlPlane, take, broker } = compose()
    const mine = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    const theirs = await controlPlane.create(
      request([
        { name: "APP_GREETING", value: "theirs" },
        { name: "FEATURE_MODE", value: "x" },
      ]),
      idempotencyKey,
      otherRequester,
    )
    expect(theirs.preview.id).not.toBe(mine.preview.id)
    expect(
      broker!.compare(mine.preview.id, otherRequester.subject, entries),
    ).toBe("unknown")
    await expect(
      controlPlane.get(mine.preview.id, otherRequester),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(take(mine.preview.id)?.values.get("APP_GREETING")?.reveal()).toBe(
      SENTINEL,
    )
  })

  it("discards the values when the queue cannot accept the preview", async () => {
    const { controlPlane, queue, store, take } = compose()
    // A store that persists the row without its queue row, so admission
    // enqueues separately -- and that enqueue fails.
    const persist = store.createOrGetWithCapacity.bind(store)
    vi.spyOn(store, "createOrGetWithCapacity").mockImplementation(
      async (input) => ({ ...(await persist(input)), enqueued: false }),
    )
    queue.shouldFailEnqueue = true
    const result = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    expect(result.preview.status).toBe("failed")
    expect(take(result.preview.id)).toBeNull()
  })

  it("discards the values when durable admission fails (capacity)", async () => {
    const { controlPlane, take } = compose()
    await controlPlane.create(request(entries), idempotencyKey, requester)
    await expect(
      controlPlane.create(request(entries), `${idempotencyKey}-2`, requester),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(take(previewIds[1])).toBeNull()
  })

  it("discards a losing concurrent registration and keeps the winner's", async () => {
    const { controlPlane, store, take } = compose()
    // Both requests pass the idempotency lookup before either persists.
    const lookup = store.getByIdempotencyKey.bind(store)
    let calls = 0
    vi.spyOn(store, "getByIdempotencyKey").mockImplementation(
      async (...args) => (calls++ < 2 ? null : lookup(...args)),
    )
    const [first, second] = await Promise.all([
      controlPlane.create(request(entries), idempotencyKey, requester),
      controlPlane.create(request(entries), idempotencyKey, requester),
    ])
    expect(first.preview.id).toBe(second.preview.id)
    expect(take(previewIds[1])).toBeNull()
    expect(take(first.preview.id)).not.toBeNull()
  })

  it("rejects a concurrent loser whose values differ from the winner's", async () => {
    const { controlPlane, store } = compose()
    const lookup = store.getByIdempotencyKey.bind(store)
    let calls = 0
    vi.spyOn(store, "getByIdempotencyKey").mockImplementation(
      async (...args) => (calls++ < 2 ? null : lookup(...args)),
    )
    const results = await Promise.allSettled([
      controlPlane.create(request(entries), idempotencyKey, requester),
      controlPlane.create(
        request([{ ...entries[0]!, value: "changed" }, entries[1]!]),
        idempotencyKey,
        requester,
      ),
    ])
    expect(results[0]?.status).toBe("fulfilled")
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT" },
    })
  })

  it("discards the values on cancel and on worker failure", async () => {
    const cancelled = compose()
    const a = await cancelled.controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    await cancelled.controlPlane.cancel(a.preview.id, requester)
    expect(cancelled.take(a.preview.id)).toBeNull()

    const failed = compose()
    const b = await failed.controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    await failed.controlPlane.failWorkerFullStackPreview(
      b.preview.id,
      "FRONTEND_FAILED",
    )
    expect(failed.take(b.preview.id)).toBeNull()
  })

  it("never lets another requester cancel (and thereby discard) these values", async () => {
    const { controlPlane, take } = compose()
    const mine = await controlPlane.create(
      request(entries),
      idempotencyKey,
      requester,
    )
    await expect(
      controlPlane.cancel(mine.preview.id, otherRequester),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(take(mine.preview.id)).not.toBeNull()
  })

  it("never exposes values through the control plane object", async () => {
    const { controlPlane } = compose()
    await controlPlane.create(request(entries), idempotencyKey, requester)
    expect(inspect(controlPlane, { depth: 12 })).not.toContain(SENTINEL)
  })
})

describe("standalone backend-v1 admission", () => {
  it("rejects a plan that names user configuration", async () => {
    const control = new BackendRuntimeControlPlane(
      { resolve: async () => configurablePlan },
      new InMemoryBackendRuntimeStore(),
      new InMemoryBackendRuntimeQueue(),
    )
    await expect(
      control.create(
        { repository, contractVersion: "backend-v1", sourceRoot: "backend" },
        requester,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BACKEND", status: 422 })
  })
})

describe("full-stack HTTP boundary for user-provided configuration", () => {
  function handler() {
    const { controlPlane, take } = compose()
    return { handle: createFullStackPreviewHttpHandler(controlPlane), take }
  }

  const post = (body: unknown) => ({
    method: "POST" as const,
    path: "/v1/fullstack-previews",
    headers: { "idempotency-key": idempotencyKey },
    body,
    requester,
  })

  it("accepts a well-formed submission without echoing values", async () => {
    const { handle, take } = handler()
    const response = await handle(post(request(entries)))
    expect(response.status).toBe(202)
    expect(JSON.stringify(response)).not.toContain(SENTINEL)
    expect(take()).not.toBeNull()
  })

  it.each([
    ["an object map", { APP_GREETING: SENTINEL }],
    [
      "a CRLF-injected value",
      [{ name: "APP_GREETING", value: `${SENTINEL}\r\nX=1` }],
    ],
    ["a NUL value", [{ name: "APP_GREETING", value: `${SENTINEL}\u0000` }]],
    [
      "an oversized value",
      [{ name: "APP_GREETING", value: SENTINEL.repeat(40) }],
    ],
    ["a reserved name", [{ name: "NODE_OPTIONS", value: SENTINEL }]],
    ["a secret-like name", [{ name: "OPENAI_API_KEY", value: SENTINEL }]],
    [
      "a duplicate name",
      [
        { name: "APP_GREETING", value: SENTINEL },
        { name: "APP_GREETING", value: SENTINEL },
      ],
    ],
    [
      "an unexpected entry field",
      [{ name: "APP_GREETING", value: SENTINEL, x: 1 }],
    ],
  ])(
    "rejects %s with a 400 that never echoes the value",
    async (_label, userEnvironment) => {
      const { handle, take } = handler()
      const response = await handle(post({ ...request(), userEnvironment }))
      expect(response.status).toBe(400)
      expect(JSON.stringify(response)).not.toContain(SENTINEL)
      expect(take()).toBeNull()
    },
  )

  it("still rejects unknown top-level fields", async () => {
    const { handle } = handler()
    const response = await handle(
      post({ ...request(entries), environment: { APP_GREETING: SENTINEL } }),
    )
    expect(response.status).toBe(400)
    expect(JSON.stringify(response)).not.toContain(SENTINEL)
  })
})

describe("authenticated listener for user-provided configuration", () => {
  let api: RunningNodePreviewApi | undefined
  afterEach(async () => api?.stop())

  it("rejects missing, forged, and expired sessions before admission", async () => {
    const secret = "test-session-signing-secret-at-least-32-bytes"
    const issuer = new PreviewSessionIssuer(secret)
    const { controlPlane, take } = compose()
    const staticControl = new PreviewControlPlane(
      { resolve: async () => validFrontendPlan },
      new InMemoryPreviewJobStore(),
      new InMemoryPreviewQueue(),
      new InMemoryPreviewArtifactCache(),
      new HmacPreviewArtifactSigner(
        "peephole.run",
        "test-signing-secret-with-at-least-32-bytes",
      ),
      new FixedWindowPreviewQuota(),
      { runnerVersion: "production-test" },
    )
    const auth = new PreviewSessionAuth(issuer)
    api = await startNodePreviewApi({
      controlPlane: staticControl,
      fullStackControlPlane: controlPlane,
      config: {
        host: "127.0.0.1",
        port: 0,
        maxBodyBytes: 16 * 1024,
        requestTimeoutMs: 5_000,
      },
      resolveRequester: (incoming) => auth.resolve(incoming),
      isReady: () => true,
    })
    const url = `http://127.0.0.1:${String(api.address.port)}/v1/fullstack-previews`
    const valid = await issuer.issue("github:1")
    const expired = await new PreviewSessionIssuer(secret, {
      now: () => new Date(Date.now() - 2 * 60 * 60 * 1000),
    }).issue("github:1")
    const [payload, expiry] = valid.token.split(".")
    const forged = `${payload}.${expiry}.${"A".repeat(43)}`

    const send = (token: string | null, key: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(request(entries)),
      })

    for (const [token, key] of [
      [null, "no-session-key-000001"],
      [forged, "forged-session-key-0001"],
      [expired.token, "expired-session-key-001"],
    ] as const) {
      const response = await send(token, key)
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(SENTINEL)
    }
    expect(take()).toBeNull()

    const accepted = await send(valid.token, "valid-session-key-00001")
    expect(accepted.status).toBe(202)
    expect(await accepted.text()).not.toContain(SENTINEL)
    expect(take()).not.toBeNull()
  })
})
