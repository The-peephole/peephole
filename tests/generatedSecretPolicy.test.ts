import { describe, expect, it } from "vitest"

import {
  assertEligiblePreviewGeneratedSecretName,
  assertValidGeneratedSecretNames,
  InvalidGeneratedSecretNameError,
  isEligiblePreviewGeneratedSecretName,
} from "../core/backendSecrets/generatedSecretPolicy"
import { PREVIEW_GENERATED_SECRET_NAMES } from "../types/backendRuntimeSecrets"

describe("isEligiblePreviewGeneratedSecretName", () => {
  it.each(PREVIEW_GENERATED_SECRET_NAMES)("accepts %s", (name) => {
    expect(isEligiblePreviewGeneratedSecretName(name)).toBe(true)
  })

  it("rejects a plausible fifth name outside the fixed allowlist", () => {
    expect(isEligiblePreviewGeneratedSecretName("APP_SECRET")).toBe(false)
  })

  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "HOME",
    "SHELL",
    "ENV",
    "BASH_ENV",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "PEEPHOLE_GITHUB_TOKEN",
    "PEEPHOLE_SESSION_SIGNING_SECRET",
  ])("rejects reserved/process-affecting name %s", (name) => {
    expect(isEligiblePreviewGeneratedSecretName(name)).toBe(false)
  })

  it.each(["PORT", "HOST", "NODE_ENV"])(
    "rejects a name that collides with platform-owned %s",
    (name) => {
      expect(isEligiblePreviewGeneratedSecretName(name)).toBe(false)
    },
  )

  it.each(["VITE_JWT_SECRET", "NEXT_PUBLIC_SESSION_SECRET"])(
    "rejects client-public exposure for %s even though the suffix matches an allowed name",
    (name) => {
      expect(isEligiblePreviewGeneratedSecretName(name)).toBe(false)
    },
  )

  it.each([
    "jwt_secret",
    "Jwt_Secret",
    "SESSION SECRET",
    "SESSION-SECRET",
    "1JWT_SECRET",
    "",
    "A".repeat(65),
  ])("rejects malformed name %j", (name) => {
    expect(isEligiblePreviewGeneratedSecretName(name)).toBe(false)
  })
})

describe("assertEligiblePreviewGeneratedSecretName", () => {
  it("returns the name unchanged when eligible", () => {
    expect(assertEligiblePreviewGeneratedSecretName("JWT_SECRET")).toBe(
      "JWT_SECRET",
    )
  })

  it("throws InvalidGeneratedSecretNameError for an ineligible name", () => {
    expect(() =>
      assertEligiblePreviewGeneratedSecretName("APP_SECRET"),
    ).toThrow(InvalidGeneratedSecretNameError)
  })
})

describe("assertValidGeneratedSecretNames", () => {
  it("accepts an empty collection", () => {
    expect(assertValidGeneratedSecretNames([])).toEqual([])
  })

  it("accepts all four allowlisted names together", () => {
    expect(
      assertValidGeneratedSecretNames([...PREVIEW_GENERATED_SECRET_NAMES]),
    ).toEqual(PREVIEW_GENERATED_SECRET_NAMES)
  })

  it("rejects duplicates even when every name is individually eligible", () => {
    expect(() =>
      assertValidGeneratedSecretNames(["JWT_SECRET", "JWT_SECRET"]),
    ).toThrow(InvalidGeneratedSecretNameError)
  })

  it("rejects the whole collection if any single name is ineligible", () => {
    expect(() =>
      assertValidGeneratedSecretNames(["JWT_SECRET", "APP_SECRET"]),
    ).toThrow(InvalidGeneratedSecretNameError)
  })

  it("can never return more names than the fixed allowlist contains", () => {
    // Eligibility already requires allowlist membership, and duplicates are
    // rejected -- so the result length is structurally bounded by the
    // allowlist's own size, with no separate "max count" needed.
    expect(PREVIEW_GENERATED_SECRET_NAMES.length).toBe(4)
    expect(() =>
      assertValidGeneratedSecretNames([
        "JWT_SECRET",
        "SESSION_SECRET",
        "COOKIE_SECRET",
        "CSRF_SECRET",
        "APP_SECRET",
      ]),
    ).toThrow(InvalidGeneratedSecretNameError)
  })
})
