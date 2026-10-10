import { describe, expect, it } from "vitest"

import {
  InvalidBackendRuntimePlanError,
  validateBackendRuntimePlan,
} from "../core/preview/backendRuntimePlanValidator"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import {
  PREVIEW_GENERATED_SECRET_NAMES,
  type PreviewGeneratedSecretName,
} from "../types/backendRuntimeSecrets"

const plan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "a".repeat(40),
  },
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  start: { command: "node", args: ["src/server.js"] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
  generatedSecretNames: [],
  databaseRequirement: null,
  userEnvironmentNames: [],
}

function withGeneratedSecretNames(value: unknown): BackendRuntimePlan {
  return {
    ...plan,
    generatedSecretNames: value as readonly PreviewGeneratedSecretName[],
  }
}

function withDatabaseRequirement(value: unknown): BackendRuntimePlan {
  return {
    ...plan,
    databaseRequirement: value as BackendRuntimePlan["databaseRequirement"],
  }
}

describe("validateBackendRuntimePlan generatedSecretNames", () => {
  it("accepts an empty names-only contract", () => {
    expect(validateBackendRuntimePlan(plan)).toBe(plan)
  })

  it("accepts a synthetic non-empty fixed-name array", () => {
    const candidate = withGeneratedSecretNames(["JWT_SECRET"])
    expect(validateBackendRuntimePlan(candidate)).toBe(candidate)
  })

  it("accepts all four canonical generated-secret names", () => {
    const candidate = withGeneratedSecretNames([
      ...PREVIEW_GENERATED_SECRET_NAMES,
    ])
    expect(validateBackendRuntimePlan(candidate)).toBe(candidate)
  })

  it("rejects a duplicate name", () => {
    expect(() =>
      validateBackendRuntimePlan(
        withGeneratedSecretNames(["SESSION_SECRET", "SESSION_SECRET"]),
      ),
    ).toThrow(/must not contain duplicates/)
  })

  it("rejects an unknown name", () => {
    expect(() =>
      validateBackendRuntimePlan(
        withGeneratedSecretNames(["ARBITRARY_SECRET"]),
      ),
    ).toThrow(/not allowlisted/)
  })

  it("rejects an array exceeding the canonical allowlist bound", () => {
    expect(() =>
      validateBackendRuntimePlan(
        withGeneratedSecretNames([
          ...PREVIEW_GENERATED_SECRET_NAMES,
          "JWT_SECRET",
        ]),
      ),
    ).toThrow(/exceed the fixed allowlist size/)
  })

  it("rejects a non-array field from an untrusted reconstructed plan", () => {
    expect(() =>
      validateBackendRuntimePlan(withGeneratedSecretNames("JWT_SECRET")),
    ).toThrow(InvalidBackendRuntimePlanError)
  })

  it("keeps platformEnvironment restricted to exactly three platform values", () => {
    expect(
      Object.keys(validateBackendRuntimePlan(plan).platformEnvironment),
    ).toEqual(["PORT", "HOST", "NODE_ENV"])

    const extraEnvironment = {
      ...plan,
      platformEnvironment: {
        ...plan.platformEnvironment,
        SESSION_SECRET: "forbidden",
      },
    } as BackendRuntimePlan
    expect(() => validateBackendRuntimePlan(extraEnvironment)).toThrow(
      /exactly PORT, HOST, and NODE_ENV/,
    )
  })
})

describe("validateBackendRuntimePlan databaseRequirement", () => {
  it("accepts null independently of generated secrets", () => {
    const candidate = withGeneratedSecretNames(["SESSION_SECRET"])
    expect(validateBackendRuntimePlan(candidate).databaseRequirement).toBeNull()
  })

  it("accepts the exact names-only DATABASE_URL contract", () => {
    const candidate = withDatabaseRequirement({ name: "DATABASE_URL" })
    expect(validateBackendRuntimePlan(candidate)).toBe(candidate)
  })

  it.each([
    undefined,
    "DATABASE_URL",
    { name: "POSTGRES_URL" },
    { name: "DATABASE_URL", value: "postgres://secret" },
    { name: "DATABASE_URL", host: "tenant.internal" },
    { name: "DATABASE_URL", port: 5433 },
    { name: "DATABASE_URL", password: "secret" },
  ])("rejects malformed or value-bearing shape %#", (value) => {
    expect(() =>
      validateBackendRuntimePlan(withDatabaseRequirement(value)),
    ).toThrow(/exact names-only DATABASE_URL contract/)
  })

  it("keeps platform, generated-secret, and database metadata independently restricted", () => {
    const candidate = {
      ...plan,
      generatedSecretNames: ["JWT_SECRET"] as const,
      databaseRequirement: { name: "DATABASE_URL" } as const,
    }
    const validated = validateBackendRuntimePlan(candidate)

    expect(Object.keys(validated.platformEnvironment)).toEqual([
      "PORT",
      "HOST",
      "NODE_ENV",
    ])
    expect(validated.generatedSecretNames).toEqual(["JWT_SECRET"])
    expect(validated.databaseRequirement).toEqual({ name: "DATABASE_URL" })
  })
})

describe("validateBackendRuntimePlan userEnvironmentNames (M12)", () => {
  const base = validateBackendRuntimePlan(validPlanForM12())

  function validPlanForM12() {
    return {
      ...plan,
      userEnvironmentNames: ["APP_GREETING", "FEATURE_MODE"],
    }
  }

  it("accepts sorted, unique, eligible names and an empty list", () => {
    expect(base.userEnvironmentNames).toEqual(["APP_GREETING", "FEATURE_MODE"])
    expect(
      validateBackendRuntimePlan({ ...plan, userEnvironmentNames: [] })
        .userEnvironmentNames,
    ).toEqual([])
  })

  it.each([
    ["missing", undefined],
    ["not an array", "APP_GREETING"],
    ["unsorted", ["FEATURE_MODE", "APP_GREETING"]],
    ["duplicated", ["APP_GREETING", "APP_GREETING"]],
    ["a platform name", ["PORT"]],
    ["a generated-secret name", ["SESSION_SECRET"]],
    ["DATABASE_URL", ["DATABASE_URL"]],
    ["a process-control name", ["NODE_OPTIONS"]],
    ["a client-public name", ["VITE_GREETING"]],
    ["a secret-like name", ["OPENAI_API_KEY"]],
    ["a lowercase name", ["app_greeting"]],
    ["a non-string", [1]],
    [
      "more than the bound",
      Array.from(
        { length: 17 },
        (_, index) => `SETTING_${String(index).padStart(2, "0")}`,
      ),
    ],
  ])("rejects %s", (_label, value) => {
    expect(() =>
      validateBackendRuntimePlan({
        ...plan,
        userEnvironmentNames: value as unknown as string[],
      }),
    ).toThrow(InvalidBackendRuntimePlanError)
  })
})
