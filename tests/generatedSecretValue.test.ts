import { describe, expect, it } from "vitest"

import {
  createOpaqueSecretValue,
  generatePreviewSecretValue,
} from "../core/backendSecrets/generatedSecretValue"

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

describe("createOpaqueSecretValue", () => {
  it("reveal() returns exactly the original value", () => {
    const sentinel = "super-secret-marker-value"
    const value = createOpaqueSecretValue(sentinel)

    expect(value.reveal()).toBe(sentinel)
  })

  it("JSON.stringify does not reveal the marker", () => {
    const sentinel = "super-secret-marker-value"
    const value = createOpaqueSecretValue(sentinel)

    expect(JSON.stringify(value)).not.toContain(sentinel)
    // A frozen object literal whose only property is a function serializes
    // to an empty object -- JSON.stringify skips function-valued properties
    // entirely, so there is no property left for it to serialize at all.
    expect(JSON.stringify(value)).toBe("{}")
  })

  it("JSON.stringify does not reveal the marker when nested inside another object", () => {
    const sentinel = "super-secret-marker-value"
    const value = createOpaqueSecretValue(sentinel)

    expect(JSON.stringify({ wrapped: value })).not.toContain(sentinel)
  })

  it("String() coercion does not reveal the marker", () => {
    const sentinel = "super-secret-marker-value"
    const value = createOpaqueSecretValue(sentinel)

    expect(String(value)).not.toContain(sentinel)
    expect(`${value}`).not.toContain(sentinel)
  })

  it("has no enumerable raw-value property", () => {
    const sentinel = "super-secret-marker-value"
    const value = createOpaqueSecretValue(sentinel)

    expect(Object.keys(value)).toEqual(["reveal"])
    expect(Object.values(value)).not.toContain(sentinel)
    for (const propertyValue of Object.values(value)) {
      expect(propertyValue).not.toBe(sentinel)
    }
  })

  it("is frozen -- reveal cannot be reassigned to leak a different closure", () => {
    const value = createOpaqueSecretValue("some-value")

    expect(Object.isFrozen(value)).toBe(true)
  })
})

describe("generatePreviewSecretValue", () => {
  it("produces a value whose revealed form is valid unpadded base64url", () => {
    const value = generatePreviewSecretValue()
    const raw = value.reveal()

    expect(raw).not.toContain("=")
    expect(BASE64URL_PATTERN.test(raw)).toBe(true)
  })

  it("decodes to exactly 32 bytes (256 bits) of material", () => {
    const value = generatePreviewSecretValue()

    expect(Buffer.from(value.reveal(), "base64url").byteLength).toBe(32)
  })

  it("contains no NUL or control characters", () => {
    const value = generatePreviewSecretValue()
    const raw = value.reveal()

    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(raw)).toBe(false)
  })

  it("produces distinct values across repeated calls", () => {
    const values = Array.from({ length: 20 }, () =>
      generatePreviewSecretValue().reveal(),
    )

    expect(new Set(values).size).toBe(values.length)
  })

  it("each call returns independent material -- generating for one logical name never influences another", () => {
    const first = generatePreviewSecretValue()
    const second = generatePreviewSecretValue()

    expect(first.reveal()).not.toBe(second.reveal())
  })
})
