import { describe, expect, it, vi } from "vitest"

import {
  deriveTemporaryDatabaseObjectName,
  mintTemporaryDatabaseResourceId,
  validateTemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"

describe("temporary database resource identity", () => {
  it("maps an exact 14-byte entropy input to the deterministic fixed format", () => {
    const entropy = vi.fn(() =>
      Uint8Array.from([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0x0c, 0x0d,
      ]),
    )

    expect(mintTemporaryDatabaseResourceId(entropy)).toBe(
      "r000102030405060708090a0b0c0d",
    )
    expect(entropy).toHaveBeenCalledExactlyOnceWith(14)
  })

  it("generates an id matching the exact fixed grammar", () => {
    expect(mintTemporaryDatabaseResourceId()).toMatch(/^r[a-f0-9]{28}$/)
  })

  it("derives the shared PostgreSQL object name from only a validated id", () => {
    expect(
      deriveTemporaryDatabaseObjectName("r000102030405060708090a0b0c0d"),
    ).toBe("pv_r000102030405060708090a0b0c0d")
  })

  it.each([
    "r0123456",
    "r0123456789abcdef0123456789abcdef",
    "R000102030405060708090a0b0c0d",
    "r000102030405060708090A0B0C0D",
    "r000102030405-60708090a0b0c0d",
    "../r000102030405060708090a0b0c0d",
    " r000102030405060708090a0b0c0d",
    "r000102030405060708090a0b0c0d ",
    'r000102030405060708090a0b0c0"',
    "r000102030405060708090a0b0c0;",
  ])("rejects malformed resource id %j", (value) => {
    expect(() => validateTemporaryDatabaseResourceId(value)).toThrow(
      /resource id is invalid/,
    )
    expect(() => deriveTemporaryDatabaseObjectName(value)).toThrow(
      /resource id is invalid/,
    )
  })

  it("accepts no repository or client identity input", () => {
    const entropy = vi.fn(() => new Uint8Array(14).fill(0xab))

    expect(mintTemporaryDatabaseResourceId(entropy)).toBe(
      "rabababababababababababababab",
    )
    expect(entropy).toHaveBeenCalledExactlyOnceWith(14)
  })

  it("fails closed when the entropy source returns the wrong length", () => {
    expect(() =>
      mintTemporaryDatabaseResourceId(() => new Uint8Array(13)),
    ).toThrow(/entropy is invalid/)
  })
})
