import { describe, expect, it } from "vitest"

import {
  FullStackPreviewApiClient,
  createFullStackPreviewRequest,
} from "../core/fullstack/apiClient"
import { resolveFullStackCandidateSupport } from "../core/fullstack/candidateSupport"
import { describeUserEnvironmentRows } from "../core/fullstack/userEnvironmentRows"
import type { BackendCandidate } from "../types/backend"
import type { EnvironmentRequirement } from "../types/environment"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "a".repeat(40),
}

function requirement(
  name: string,
  overrides: Partial<EnvironmentRequirement> = {},
): EnvironmentRequirement {
  return {
    name,
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

const candidate: BackendCandidate = {
  sourceRoot: "backend",
  framework: "express",
  runtime: "node",
  packageName: "backend",
  packageManager: null,
  entrypoint: "src/server.js",
  databaseDependencies: [],
  environmentRequirements: [requirement("APP_GREETING")],
  packageLockPresent: true,
  evidence: [],
  warnings: [],
}

describe("createFullStackPreviewRequest", () => {
  it("omits userEnvironment when there is none, keeping legacy requests unchanged", () => {
    const base = {
      repository,
      frontendSourceRoot: "frontend",
      backendSourceRoot: "backend",
    }
    expect(createFullStackPreviewRequest(base)).not.toHaveProperty(
      "userEnvironment",
    )
    expect(
      createFullStackPreviewRequest({ ...base, userEnvironment: [] }),
    ).not.toHaveProperty("userEnvironment")
    expect(
      createFullStackPreviewRequest({
        ...base,
        userEnvironment: [{ name: "APP_GREETING", value: "Hello" }],
      }).userEnvironment,
    ).toEqual([{ name: "APP_GREETING", value: "Hello" }])
  })
})

describe("FullStackPreviewApiClient", () => {
  it("accepts the CONFIGURATION_UNAVAILABLE preview error code", async () => {
    const client = new FullStackPreviewApiClient("https://api.example/", {
      getSession: () => ({
        token: "session",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "fullstack-12345678-1234-1234-1234-123456789abc",
            repository,
            frontendSourceRoot: "frontend",
            backendSourceRoot: "backend",
            status: "failed",
            url: null,
            errorCode: "CONFIGURATION_UNAVAILABLE",
            errorMessage: "Start a new preview and enter them again.",
            createdAt: "2026-10-11T00:00:00.000Z",
            updatedAt: "2026-10-11T00:00:00.000Z",
            expiresAt: "2026-10-11T00:15:00.000Z",
          }),
          { status: 200 },
        ),
    })
    await expect(
      client.get("fullstack-12345678-1234-1234-1234-123456789abc"),
    ).resolves.toMatchObject({ errorCode: "CONFIGURATION_UNAVAILABLE" })
  })
})

describe("resolveFullStackCandidateSupport with user configuration", () => {
  it("is eligible only when the build enables user configuration", () => {
    expect(
      resolveFullStackCandidateSupport(repository, candidate).supported,
    ).toBe(false)
    expect(
      resolveFullStackCandidateSupport(repository, candidate, {
        userEnvironmentEnabled: true,
      }).supported,
    ).toBe(true)
  })

  it("stays ineligible for an external API key even when enabled", () => {
    expect(
      resolveFullStackCandidateSupport(
        repository,
        {
          ...candidate,
          environmentRequirements: [
            requirement("APP_GREETING"),
            requirement("OPENAI_API_KEY", {
              requirementKind: "user-required",
              sensitivity: "secret-like",
            }),
          ],
        },
        { userEnvironmentEnabled: true },
      ).supported,
    ).toBe(false)
  })
})

describe("describeUserEnvironmentRows", () => {
  it("labels each declared name once, sorted, with input only for configurable names", () => {
    expect(
      describeUserEnvironmentRows([
        requirement("PORT", { requirementKind: "auto-configurable" }),
        requirement("OPENAI_API_KEY", {
          requirementKind: "user-required",
          sensitivity: "secret-like",
        }),
        requirement("APP_GREETING"),
        requirement("APP_GREETING", { sourceTemplate: ".env.sample" }),
        requirement("VITE_TITLE", { exposure: "client-public" }),
      ]).map(({ name, source, acceptsInput }) => [name, source, acceptsInput]),
    ).toEqual([
      ["APP_GREETING", "You", true],
      ["OPENAI_API_KEY", "Unsupported", false],
      ["PORT", "Peephole", false],
      ["VITE_TITLE", "Unsupported", false],
    ])
  })
})
