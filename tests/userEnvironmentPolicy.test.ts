import { describe, expect, it } from "vitest"

import {
  InvalidUserEnvironmentError,
  assertUserEnvironmentMatchesNames,
  assertValidUserEnvironmentValue,
  classifyUserEnvironmentName,
  classifyUserEnvironmentRequirement,
  isEligibleUserEnvironmentName,
  parseUserEnvironmentEntries,
  resolveUserEnvironmentNames,
} from "../core/userEnvironment/userEnvironmentPolicy"
import type { EnvironmentRequirement } from "../types/environment"

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"
const char = (code: number) => String.fromCharCode(code)

function requirement(
  overrides: Partial<EnvironmentRequirement> = {},
): EnvironmentRequirement {
  return {
    name: "APP_GREETING",
    sourceRoot: "backend",
    sourceTemplate: ".env.example",
    exposure: "server",
    requirementKind: "unknown",
    sensitivity: "unknown",
    evidence: [],
    warnings: [],
    ...overrides,
  }
}

describe("user environment name policy", () => {
  it.each(["APP_GREETING", "FEATURE_MODE", "GREETING", "A", "X1_Y2"])(
    "accepts the non-sensitive server name %s",
    (name) => {
      expect(classifyUserEnvironmentName(name)).toBe("user-configurable")
    },
  )

  it.each([
    ["PORT", "platform-managed"],
    ["HOST", "platform-managed"],
    ["NODE_ENV", "platform-managed"],
    ["JWT_SECRET", "generated-secret"],
    ["SESSION_SECRET", "generated-secret"],
    ["COOKIE_SECRET", "generated-secret"],
    ["CSRF_SECRET", "generated-secret"],
    ["DATABASE_URL", "temporary-database"],
    ["NODE_OPTIONS", "reserved-unsupported"],
    ["NODE_PATH", "reserved-unsupported"],
    ["NODE_EXTRA_CA_CERTS", "reserved-unsupported"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "reserved-unsupported"],
    ["PATH", "reserved-unsupported"],
    ["HOME", "reserved-unsupported"],
    ["LD_PRELOAD", "reserved-unsupported"],
    ["LD_LIBRARY_PATH", "reserved-unsupported"],
    ["NPM_CONFIG_REGISTRY", "reserved-unsupported"],
    ["NPM_TOKEN", "reserved-unsupported"],
    ["PEEPHOLE_ANYTHING", "reserved-unsupported"],
    ["GLIBC_TUNABLES", "reserved-unsupported"],
    ["HTTPS_PROXY", "reserved-unsupported"],
    ["VITE_GREETING", "client-public-unsupported"],
    ["NEXT_PUBLIC_GREETING", "client-public-unsupported"],
    ["REACT_APP_GREETING", "client-public-unsupported"],
    ["OPENAI_API_KEY", "secret-like-unsupported"],
    ["STRIPE_SECRET_KEY", "secret-like-unsupported"],
    ["STRIPE_KEY", "secret-like-unsupported"],
    ["AWS_ACCESS_KEY_ID", "secret-like-unsupported"],
    ["GITHUB_TOKEN", "secret-like-unsupported"],
    ["GITHUB_PAT", "secret-like-unsupported"],
    ["ADMIN_PASSWORD", "secret-like-unsupported"],
    ["SENTRY_DSN", "secret-like-unsupported"],
    ["REDIS_URL", "secret-like-unsupported"],
    ["DB_NAME", "secret-like-unsupported"],
    ["POSTGRES_URL", "secret-like-unsupported"],
    ["API_URL", "external-routing-unsupported"],
    ["SMTP_HOST", "external-routing-unsupported"],
    ["APP_PORT", "external-routing-unsupported"],
    ["CALLBACK_ENDPOINT", "external-routing-unsupported"],
    ["app_greeting", "invalid-name-unsupported"],
    ["App_Greeting", "invalid-name-unsupported"],
    ["Port", "invalid-name-unsupported"],
    ["node_options", "invalid-name-unsupported"],
    ["_GREETING", "invalid-name-unsupported"],
    ["1GREETING", "invalid-name-unsupported"],
    ["GREETING-MODE", "invalid-name-unsupported"],
    ["", "invalid-name-unsupported"],
    ["__proto__", "invalid-name-unsupported"],
    [`A${"B".repeat(64)}`, "invalid-name-unsupported"],
  ] as const)("classifies %s as %s", (name, disposition) => {
    expect(classifyUserEnvironmentName(name)).toBe(disposition)
    expect(isEligibleUserEnvironmentName(name)).toBe(false)
  })

  it("requires the analyzer classification to agree before a name is configurable", () => {
    expect(classifyUserEnvironmentRequirement(requirement())).toBe(
      "user-configurable",
    )
    expect(
      classifyUserEnvironmentRequirement(
        requirement({ sensitivity: "secret-like" }),
      ),
    ).toBe("secret-like-unsupported")
    expect(
      classifyUserEnvironmentRequirement(
        requirement({ requirementKind: "user-required" }),
      ),
    ).toBe("secret-like-unsupported")
    expect(
      classifyUserEnvironmentRequirement(
        requirement({ requirementKind: "external-routing-candidate" }),
      ),
    ).toBe("external-routing-unsupported")
    expect(
      classifyUserEnvironmentRequirement(
        requirement({ exposure: "client-public" }),
      ),
    ).toBe("client-public-unsupported")
    expect(
      classifyUserEnvironmentRequirement(
        requirement({ requirementKind: "auto-configurable" }),
      ),
    ).toBe("reserved-unsupported")
  })

  it("resolves sorted, de-duplicated names and refuses more than the bound", () => {
    expect(
      resolveUserEnvironmentNames([
        requirement({ name: "ZETA" }),
        requirement({ name: "ALPHA" }),
        requirement({ name: "ALPHA", sourceTemplate: ".env.sample" }),
        requirement({ name: "OPENAI_API_KEY" }),
        requirement({ name: "PORT", requirementKind: "auto-configurable" }),
      ]),
    ).toEqual(["ALPHA", "ZETA"])
    const many = Array.from({ length: 17 }, (_, index) =>
      requirement({ name: `SETTING_${String(index)}` }),
    )
    expect(resolveUserEnvironmentNames(many)).toBeNull()
    expect(resolveUserEnvironmentNames(many.slice(1))).toHaveLength(16)
  })
})

describe("user environment value policy", () => {
  it.each([
    ["Hello", "ASCII"],
    ["안녕하세요 👋", "non-ASCII and astral Unicode"],
    ["a=b; $(rm -rf /) `x` \"q\" 'q' \\", "shell and env-file metacharacters"],
    ["x".repeat(1_024), "exactly 1024 bytes"],
  ])("accepts %j (%s)", (value) => {
    expect(assertValidUserEnvironmentValue("APP_GREETING", value)).toBe(value)
  })

  it.each([
    [char(0), "NUL"],
    [`a${char(10)}b`, "LF"],
    [`a${char(13)}b`, "CR"],
    [`a${char(13)}${char(10)}INJECTED=1`, "CRLF injection"],
    [`a${char(9)}b`, "TAB"],
    [char(0x1b), "ESC"],
    [char(0x7f), "DEL"],
    [char(0x85), "C1 NEL"],
    [char(0x2028), "line separator"],
    [char(0x2029), "paragraph separator"],
    [char(0xfeff), "byte-order mark"],
    [char(0xd800), "lone high surrogate"],
    [`a${char(0xdc00)}`, "lone low surrogate"],
    ["x".repeat(1_025), "1025 bytes"],
    ["가".repeat(342), "1026 UTF-8 bytes in 342 characters"],
    ["", "an empty string"],
  ])("rejects %j (%s) without echoing it", (value) => {
    let thrown: unknown
    try {
      assertValidUserEnvironmentValue("APP_GREETING", value)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidUserEnvironmentError)
    expect((thrown as Error).message).toContain("APP_GREETING")
    if (value.length > 0) {
      expect((thrown as Error).message).not.toContain(value)
    }
  })

  it.each([null, 1, true, {}, []])("rejects a non-string value %j", (value) => {
    expect(() =>
      assertValidUserEnvironmentValue("APP_GREETING", value),
    ).toThrow(InvalidUserEnvironmentError)
  })
})

describe("parseUserEnvironmentEntries", () => {
  it("returns validated entries sorted by name", () => {
    expect(
      parseUserEnvironmentEntries([
        { name: "FEATURE_MODE", value: "demo" },
        { name: "APP_GREETING", value: SENTINEL },
      ]),
    ).toEqual([
      { name: "APP_GREETING", value: SENTINEL },
      { name: "FEATURE_MODE", value: "demo" },
    ])
    expect(parseUserEnvironmentEntries([])).toEqual([])
  })

  it.each([
    ["an object map", { APP_GREETING: "x" }],
    ["a string", "APP_GREETING=x"],
    ["null", null],
    ["an entry with an extra field", [{ name: "A", value: "x", secret: true }]],
    ["an entry missing value", [{ name: "A" }]],
    ["an entry that is an array", [["A", "x"]]],
    ["a null entry", [null]],
    ["a non-string name", [{ name: 1, value: "x" }]],
    ["a lowercase name", [{ name: "app_greeting", value: "x" }]],
    ["a reserved name", [{ name: "NODE_OPTIONS", value: "--require=x" }]],
    ["a generated-secret name", [{ name: "SESSION_SECRET", value: "x" }]],
    ["DATABASE_URL", [{ name: "DATABASE_URL", value: "postgres://x" }]],
    ["PORT override", [{ name: "PORT", value: "1" }]],
    ["a client-public name", [{ name: "VITE_GREETING", value: "x" }]],
    ["a secret-like name", [{ name: "OPENAI_API_KEY", value: SENTINEL }]],
    [
      "a duplicate name",
      [
        { name: "APP_GREETING", value: "a" },
        { name: "APP_GREETING", value: "b" },
      ],
    ],
    [
      "too many entries",
      Array.from({ length: 17 }, (_, index) => ({
        name: `SETTING_${String(index)}`,
        value: "x",
      })),
    ],
    [
      "a total payload over 8 KiB",
      Array.from({ length: 9 }, (_, index) => ({
        name: `SETTING_${String(index)}`,
        value: "x".repeat(1_000),
      })),
    ],
  ])("rejects %s", (_label, value) => {
    let thrown: unknown
    try {
      parseUserEnvironmentEntries(value)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidUserEnvironmentError)
    expect((thrown as Error).message).not.toContain(SENTINEL)
  })
})

describe("assertUserEnvironmentMatchesNames", () => {
  const entries = [
    { name: "APP_GREETING", value: SENTINEL },
    { name: "FEATURE_MODE", value: "demo" },
  ]

  it("accepts exactly the server-derived names", () => {
    expect(() =>
      assertUserEnvironmentMatchesNames(entries, [
        "APP_GREETING",
        "FEATURE_MODE",
      ]),
    ).not.toThrow()
  })

  it("rejects a missing value", () => {
    expect(() =>
      assertUserEnvironmentMatchesNames(entries.slice(0, 1), [
        "APP_GREETING",
        "FEATURE_MODE",
      ]),
    ).toThrow("A value for FEATURE_MODE is required.")
  })

  it("rejects a name the commit does not declare", () => {
    expect(() =>
      assertUserEnvironmentMatchesNames(entries, ["APP_GREETING"]),
    ).toThrow(/FEATURE_MODE is not a user-configurable variable/)
  })

  it("rejects any submission when the backend declares nothing", () => {
    expect(() => assertUserEnvironmentMatchesNames(entries, [])).toThrow(
      InvalidUserEnvironmentError,
    )
    expect(() => assertUserEnvironmentMatchesNames([], [])).not.toThrow()
  })
})
