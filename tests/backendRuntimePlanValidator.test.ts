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
}

function withGeneratedSecretNames(value: unknown): BackendRuntimePlan {
  return {
    ...plan,
    generatedSecretNames: value as readonly PreviewGeneratedSecretName[],
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
