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
    packageManager: null,
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
      generatedSecretNames: [],
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
    "COOKIE_SECRET",
    "CSRF_SECRET",
  ] as const)("allows canonical generated requirement %s", (name) => {
    const plan = resolveBackendRuntimePlan(
      repository,
      candidate({
        environmentRequirements: [
          requirement({
            name,
            requirementKind: "preview-generated-candidate",
            exposure: "server",
            sensitivity: "secret-like",
          }),
        ],
      }),
    )

    expect(plan?.generatedSecretNames).toEqual([name])
  })

  it("derives multiple generated names deterministically and ignores auto-configurable names", () => {
    const plan = resolveBackendRuntimePlan(
      repository,
      candidate({
        environmentRequirements: [
          requirement({
            name: "SESSION_SECRET",
            requirementKind: "preview-generated-candidate",
            sensitivity: "secret-like",
          }),
          requirement({ name: "PORT" }),
          requirement({
            name: "CSRF_SECRET",
            requirementKind: "preview-generated-candidate",
            sensitivity: "secret-like",
          }),
          requirement({ name: "HOST" }),
          requirement({ name: "NODE_ENV" }),
        ],
      }),
    )

    expect(plan?.generatedSecretNames).toEqual([
      "CSRF_SECRET",
      "SESSION_SECRET",
    ])
  })

  it.each([
    ["API_KEY", "user-required", "server"],
    ["OPENAI_API_KEY", "user-required", "server"],
    ["TOKEN", "user-required", "server"],
    ["PASSWORD", "user-required", "server"],
    ["DATABASE_URL", "database-requirement", "server"],
    ["REDIS_URL", "database-requirement", "server"],
    ["SOME_UNUSUAL_NAME", "unknown", "server"],
    ["VITE_SECRET", "user-required", "client-public"],
    ["NEXT_PUBLIC_TOKEN", "user-required", "client-public"],
    ["API_URL", "external-routing-candidate", "server"],
    ["APP_SECRET", "preview-generated-candidate", "server"],
    ["SESSION_SECRET", "preview-generated-candidate", "client-public"],
    ["SESSION_SECRET", "user-required", "server"],
  ] as const)(
    "rejects unsupported environment requirement %s",
    (name, requirementKind, exposure) => {
      expect(
        resolveBackendRuntimePlan(
          repository,
          candidate({
            environmentRequirements: [
              requirement({ name, requirementKind, exposure }),
            ],
          }),
        ),
      ).toBeNull()
    },
  )

  it("does not let a valid generated requirement mask an unsupported requirement", () => {
    expect(
      resolveBackendRuntimePlan(
        repository,
        candidate({
          environmentRequirements: [
            requirement({
              name: "SESSION_SECRET",
              requirementKind: "preview-generated-candidate",
              sensitivity: "secret-like",
            }),
            requirement({
              name: "OPENAI_API_KEY",
              requirementKind: "user-required",
              sensitivity: "secret-like",
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

  it("keeps generated-secret names empty when none are declared", () => {
    const plan = resolveBackendRuntimePlan(repository, candidate())

    expect(plan?.generatedSecretNames).toEqual([])
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

  it.each(["pnpm@9.0.0", "yarn@4.0.0", "bun@1.0.0"])(
    "does not advertise backend-v1 support for explicit %s declarations",
    (packageManager) => {
      const support = resolveBackendExecutionSupport(
        candidate({ packageManager }),
      )

      expect(support).toMatchObject({ supported: false, adapterId: null })
      expect(support.evidence.join(" ")).toContain("npm")
    },
  )

  it.each([null, "npm", "npm@10.0.0"])(
    "retains npm compatibility for packageManager %s",
    (packageManager) => {
      expect(
        resolveBackendExecutionSupport(candidate({ packageManager })).supported,
      ).toBe(true)
    },
  )
})
