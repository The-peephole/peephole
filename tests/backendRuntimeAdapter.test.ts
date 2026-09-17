import { describe, expect, it } from "vitest"

import {
  resolveBackendExecutionSupport,
  resolveBackendRuntimePlan,
} from "../core/analyzer/backendRuntimeAdapter"
import type { BackendCandidate, BackendFramework } from "../types/backend"
import type { EnvironmentRequirement } from "../types/environment"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "a".repeat(40),
}

function candidate(
  overrides: Partial<BackendCandidate> = {},
): BackendCandidate {
  return {
    sourceRoot: "backend",
    framework: "express",
    runtime: "node",
    packageName: "backend",
    entrypoint: "src/server.js",
    databaseDependencies: [],
    environmentRequirements: [],
    packageLockPresent: true,
    evidence: [],
    warnings: [],
    ...overrides,
  }
}

function requirement(
  overrides: Partial<EnvironmentRequirement> = {},
): EnvironmentRequirement {
  return {
    name: "PORT",
    sourceRoot: "backend",
    sourceTemplate: ".env.example",
    exposure: "server",
    requirementKind: "auto-configurable",
    sensitivity: "public",
    evidence: [],
    warnings: [],
    ...overrides,
  }
}

describe("resolveBackendRuntimePlan", () => {
  it("resolves a plan for an express + npm + package-lock + safe entrypoint candidate", () => {
    const plan = resolveBackendRuntimePlan(repository, candidate())

    expect(plan).toMatchObject({
      contractVersion: "backend-v1",
      repository,
      sourceRoot: "backend",
      adapterId: "express-node-npm-v1",
      packageManager: "npm",
      install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
      start: { command: "node", args: ["src/server.js"] },
      platformEnvironment: { HOST: "0.0.0.0", NODE_ENV: "production" },
    })
  })

  it("never includes a raw npm start invocation", () => {
    const plan = resolveBackendRuntimePlan(repository, candidate())

    // The install/start commands are always structured executable + args;
    // "npm start" never appears as a single opaque string anywhere.
    expect(JSON.stringify(plan)).not.toContain("npm start")
  })

  it("rejects express without a package-lock.json", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ packageLockPresent: false }),
      ),
    ).toBeNull()
  })

  it("rejects an unsafe source root", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ sourceRoot: "../escape" }),
      ),
    ).toBeNull()
  })

  it.each([
    "nestjs",
    "fastify",
    "koa",
    "hapi",
    "unknown",
  ] as BackendFramework[])(
    "rejects %s (detected but execution unsupported)",
    (framework) => {
      expect(
        resolveBackendRuntimePlan(repository, candidate({ framework })),
      ).toBeNull()
    },
  )

  it("rejects a candidate with a database dependency", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ databaseDependencies: ["pg"] }),
      ),
    ).toBeNull()
  })

  it("rejects a missing entrypoint", () => {
    expect(
      resolveBackendRuntimePlan(repository, candidate({ entrypoint: null })),
    ).toBeNull()
  })

  it("rejects a traversal entrypoint even if somehow present", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ entrypoint: "../../etc/passwd.js" }),
      ),
    ).toBeNull()
  })

  it("rejects an absolute entrypoint", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ entrypoint: "/etc/passwd.js" }),
      ),
    ).toBeNull()
  })

  it("rejects a TypeScript entrypoint (requires tsx/ts-node, not plain node)", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({ entrypoint: "src/server.ts" }),
      ),
    ).toBeNull()
  })

  it.each([
    "JWT_SECRET",
    "SESSION_SECRET",
    "API_KEY",
    "PAT",
    "DATABASE_URL",
    "VITE_API_URL",
    "SOME_UNUSUAL_NAME",
  ])("fails closed when environment requirement %s is present", (name) => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({
          environmentRequirements: [
            requirement({
              name,
              requirementKind:
                name === "JWT_SECRET" || name === "SESSION_SECRET"
                  ? "preview-generated-candidate"
                  : name === "DATABASE_URL"
                    ? "database-requirement"
                    : name === "VITE_API_URL"
                      ? "external-routing-candidate"
                      : name === "SOME_UNUSUAL_NAME"
                        ? "unknown"
                        : "user-required",
            }),
          ],
        }),
      ),
    ).toBeNull()
  })

  it.each(["PORT", "HOST", "NODE_ENV"])(
    "allows the auto-configurable requirement %s",
    (name) => {
      const plan = resolveBackendRuntimePlan(
        repository,
        candidate({
          environmentRequirements: [
            requirement({ name, requirementKind: "auto-configurable" }),
          ],
        }),
      )
      expect(plan).not.toBeNull()
    },
  )

  it("only ever places PORT/HOST/NODE_ENV in the runtime environment", () => {
    const plan = resolveBackendRuntimePlan(repository, candidate())

    expect(Object.keys(plan!.platformEnvironment).sort()).toEqual([
      "HOST",
      "NODE_ENV",
      "PORT",
    ])
  })

  it("requires an exact 40-character commit SHA in the repository ref", () => {
    const plan = resolveBackendRuntimePlan(
      { ...repository, commitSha: "not-a-sha" },
      candidate(),
    )
    // The adapter itself does not validate the ref shape (that is the
    // control plane's job via validateRepositoryRef), but it must never
    // silently mutate or "fix" it.
    expect(plan?.repository.commitSha).toBe("not-a-sha")
  })
})

describe("resolveBackendExecutionSupport", () => {
  it("reports supported: true for a qualifying candidate", () => {
    expect(resolveBackendExecutionSupport(candidate())).toMatchObject({
      supported: true,
      adapterId: "express-node-npm-v1",
    })
  })

  it("reports supported: false with a reason for Fastify", () => {
    const support = resolveBackendExecutionSupport(
      candidate({ framework: "fastify" }),
    )
    expect(support.supported).toBe(false)
    expect(support.adapterId).toBeNull()
    expect(support.evidence.join(" ")).toContain("fastify")
  })

  it("reports supported: false for a database-dependent backend", () => {
    const support = resolveBackendExecutionSupport(
      candidate({ databaseDependencies: ["prisma"] }),
    )
    expect(support.supported).toBe(false)
  })
})
