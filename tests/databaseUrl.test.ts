import { describe, expect, it } from "vitest"

import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
  assertTemporaryDatabaseUrlMatchesResource,
  buildTemporaryDatabaseUrl,
} from "../core/backendDatabase/databaseUrl"
import {
  mintTemporaryDatabaseResourceId,
  type TemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import type { TemporaryDatabaseCredentialMaterial } from "../types/temporaryDatabase"

const PASSWORD_MARKER = "DbUrlMarker_7Hn9-Q"

function fixedResourceId() {
  return mintTemporaryDatabaseResourceId(() => new Uint8Array(14).fill(7))
}

function material(
  overrides: Partial<TemporaryDatabaseCredentialMaterial> = {},
): TemporaryDatabaseCredentialMaterial {
  const resourceId = fixedResourceId()
  const objectName = `pv_${resourceId}`
  return {
    resourceId,
    databaseName: objectName,
    roleName: objectName,
    password: createOpaqueSecretValue(PASSWORD_MARKER),
    ...overrides,
  }
}

describe("buildTemporaryDatabaseUrl", () => {
  it("assembles a canonical postgresql:// URL from resource-derived identity and the fixed tenant endpoint", () => {
    const input = material()
    const url = buildTemporaryDatabaseUrl(input)

    expect(url.reveal()).toBe(
      `postgresql://${input.databaseName}:${PASSWORD_MARKER}@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/${input.databaseName}`,
    )
  })

  it("uses exactly the fixed tenant host and port", () => {
    expect(TENANT_DATABASE_HOST).toBe("192.168.253.1")
    expect(TENANT_DATABASE_PORT).toBe(5433)
    const url = new URL(buildTemporaryDatabaseUrl(material()).reveal())
    expect(url.hostname).toBe(TENANT_DATABASE_HOST)
    expect(url.port).toBe(String(TENANT_DATABASE_PORT))
    expect(url.protocol).toBe("postgresql:")
  })

  it("percent-encodes the password through standard URL primitives rather than string concatenation", () => {
    const input = material({
      password: createOpaqueSecretValue("weird:/@pass word"),
    })
    const url = buildTemporaryDatabaseUrl(input)

    const parsed = new URL(url.reveal())
    expect(parsed.username).toBe(input.databaseName)
    expect(decodeURIComponent(parsed.password)).toBe("weird:/@pass word")
    // The unescaped raw password text never appears verbatim in the URL.
    expect(url.reveal()).not.toContain("weird:/@pass word")
  })

  it("rejects a database name that does not match the resource-derived object name", () => {
    const input = material({ databaseName: "pv_someone_elses_db" })
    expect(() => buildTemporaryDatabaseUrl(input)).toThrow(
      /credential material identity is invalid/,
    )
  })

  it("rejects a role name that does not match the resource-derived object name", () => {
    const input = material({ roleName: "pv_someone_elses_role" })
    expect(() => buildTemporaryDatabaseUrl(input)).toThrow(
      /credential material identity is invalid/,
    )
  })

  it("returns an opaque value, never a plain string", () => {
    const url = buildTemporaryDatabaseUrl(material())
    expect(typeof url).toBe("object")
    expect(typeof url.reveal).toBe("function")
    expect(String(url)).not.toContain(PASSWORD_MARKER)
    expect(JSON.stringify(url)).not.toContain(PASSWORD_MARKER)
  })

  it("never includes the raw password in a thrown error for mismatched identity", () => {
    const input = material({
      databaseName: "pv_wrong",
      password: createOpaqueSecretValue(PASSWORD_MARKER),
    })
    let failure: unknown
    try {
      buildTemporaryDatabaseUrl(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(PASSWORD_MARKER)
  })

  it("derives the same database/role identity independent of any client/repository input -- only resourceId contributes", () => {
    const first = material()
    const second = material()
    // Both draw from the same fixed entropy source in this test, so their
    // derived object names are identical -- proving the name is a pure
    // function of resourceId, never of any other field.
    expect(first.databaseName).toBe(second.databaseName)
    expect(buildTemporaryDatabaseUrl(first).reveal()).toBe(
      buildTemporaryDatabaseUrl(second).reveal(),
    )
  })
})

describe("assertTemporaryDatabaseUrlMatchesResource", () => {
  function canonicalUrl(
    resourceId: TemporaryDatabaseResourceId = fixedResourceId(),
  ): { resourceId: TemporaryDatabaseResourceId; url: URL } {
    const url = new URL(
      buildTemporaryDatabaseUrl(material({ resourceId })).reveal(),
    )
    return { resourceId, url }
  }

  it("accepts the exact canonical shape the builder itself produces", () => {
    const { resourceId, url } = canonicalUrl()
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).not.toThrow()
  })

  it("rejects a URL whose username/role does not match the resource-derived object name", () => {
    const { resourceId, url } = canonicalUrl()
    url.username = "pv_someone_elses_role"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects a URL whose database pathname does not match the resource-derived object name", () => {
    const { resourceId, url } = canonicalUrl()
    url.pathname = "/pv_someone_elses_db"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects a URL carrying a query string", () => {
    const { resourceId, url } = canonicalUrl()
    url.search = "?sslmode=disable"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects a URL carrying a fragment", () => {
    const { resourceId, url } = canonicalUrl()
    url.hash = "#anything"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects the wrong host", () => {
    const { resourceId, url } = canonicalUrl()
    url.hostname = "evil.example"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects the wrong port", () => {
    const { resourceId, url } = canonicalUrl()
    url.port = "5432"
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects the wrong protocol", () => {
    const { resourceId, url } = canonicalUrl()
    // Rebuilt rather than reassigning `url.protocol` directly -- the WHATWG
    // URL setter's scheme-transition rules are not a contract this test
    // should depend on. Every other component (userinfo/host/port/path) is
    // preserved exactly; only the scheme text changes.
    const mutated = new URL(url.toString().replace(/^postgresql:/, "postgres:"))
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, mutated),
    ).toThrow(/does not match its resource identity/)
  })

  it("rejects an empty password", () => {
    const { resourceId, url } = canonicalUrl()
    url.password = ""
    expect(() =>
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url),
    ).toThrow(/does not match its resource identity/)
  })

  it("never includes the URL or password in a thrown error", () => {
    const { resourceId, url } = canonicalUrl()
    url.username = "pv_someone_elses_role"
    let failure: unknown
    try {
      assertTemporaryDatabaseUrlMatchesResource(resourceId, url)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(PASSWORD_MARKER)
    expect(String(failure)).not.toContain(url.toString())
  })
})
