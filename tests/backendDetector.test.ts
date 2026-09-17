import { describe, expect, it } from "vitest"

import {
  assembleBackendDetection,
  detectBackendCandidate,
} from "../core/analyzer/backendDetector"
import type { ParsedPackageJson } from "../core/analyzer/packageJson"

describe("detectBackendCandidate", () => {
  it.each([
    ["express", "express"],
    ["@nestjs/core", "nestjs"],
    ["fastify", "fastify"],
    ["koa", "koa"],
    ["@hapi/hapi", "hapi"],
    ["hapi", "hapi"],
  ] as const)("recognizes %s as %s", (dependency, framework) => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { [dependency]: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.framework).toBe(framework)
    expect(candidate?.sourceRoot).toBe("backend")
    expect(candidate?.runtime).toBe("node")
  })

  it("does not invent a framework from a database dependency alone", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { pg: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.framework).toBe("unknown")
    expect(candidate?.databaseDependencies).toEqual(["pg"])
  })

  it("preserves database/server dependency evidence alongside a confirmed framework", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest", pg: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.framework).toBe("express")
    expect(candidate?.databaseDependencies).toEqual(["pg"])
    expect(candidate?.evidence.join(" ")).toContain("pg")
  })

  it("does not create a candidate from a hosted backend client alone", () => {
    const supabase = detectBackendCandidate(
      "app",
      packageJson({ dependencies: { "@supabase/supabase-js": "latest" } }),
      null,
      [],
      {},
    )
    const firebase = detectBackendCandidate(
      "app",
      packageJson({ dependencies: { firebase: "latest" } }),
      null,
      [],
      {},
    )

    expect(supabase).toBeNull()
    expect(firebase).toBeNull()
  })

  it("reports a hosted backend client as a warning on an already-qualifying candidate, not local backend evidence", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({
        dependencies: { express: "latest", firebase: "latest" },
      }),
      null,
      [],
      {},
    )

    expect(candidate?.framework).toBe("express")
    expect(candidate?.warnings.join(" ")).toContain("Hosted backend client")
  })

  it("does not confirm a backend from a directory name with no package evidence", () => {
    const candidate = detectBackendCandidate("backend", null, null, [], {})

    expect(candidate).toBeNull()
  })

  it("does not mislabel a frontend-only candidate as backend", () => {
    const candidate = detectBackendCandidate(
      "frontend",
      packageJson({ dependencies: { react: "latest", vite: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate).toBeNull()
  })

  it("records a start script as supporting evidence", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({
        dependencies: { express: "latest" },
        scripts: { start: "node src/server.js" },
      }),
      null,
      [],
      {},
    )

    expect(candidate?.evidence.join(" ")).toContain("start script")
  })

  it("resolves a safe explicit entrypoint from a narrow start script grammar", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({
        dependencies: { express: "latest" },
        scripts: { start: "node src/server.js" },
      }),
      null,
      [],
      {},
    )

    expect(candidate?.entrypoint).toBe("src/server.js")
  })

  it.each([
    "node src/server.js && echo done",
    "node src/server.js; rm -rf /",
    "node $ENTRY",
    "node ../server.js",
    "node /etc/passwd.js",
    'concurrently "node a.js" "node b.js"',
  ])("does not resolve an entrypoint from an unsafe script (%s)", (script) => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({
        dependencies: { express: "latest" },
        scripts: { start: script },
      }),
      null,
      [],
      {},
    )

    expect(candidate?.entrypoint).toBeNull()
  })

  it("falls back to the dev script when no start script resolves an entrypoint", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({
        dependencies: { express: "latest" },
        scripts: { dev: "tsx src/index.ts" },
      }),
      null,
      [],
      {},
    )

    expect(candidate?.entrypoint).toBe("src/index.ts")
  })

  it("degrades safely for a malformed nested package.json without crashing", () => {
    const candidate = detectBackendCandidate(
      "backend",
      null,
      "package.json contains invalid JSON.",
      [],
      {},
    )

    expect(candidate).not.toBeNull()
    expect(candidate?.framework).toBe("unknown")
    expect(candidate?.warnings.join(" ")).toContain("could not be parsed")
  })

  it("adds conventional directory-name evidence only alongside a qualifying candidate", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.evidence.join(" ")).toContain(
      'Directory name "backend" matches a conventional backend location',
    )
  })

  it("supports the repository root as a backend source root", () => {
    const candidate = detectBackendCandidate(
      ".",
      packageJson({ dependencies: { express: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.sourceRoot).toBe(".")
  })

  it("preserves a nested workspace sourceRoot", () => {
    const candidate = detectBackendCandidate(
      "apps/api",
      packageJson({ dependencies: { fastify: "latest" } }),
      null,
      [],
      {},
    )

    expect(candidate?.sourceRoot).toBe("apps/api")
  })

  it("classifies its own environment template scoped to its sourceRoot", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest" } }),
      null,
      [".env.example"],
      { ".env.example": "PORT=3000\nJWT_SECRET=\n" },
    )

    expect(
      candidate?.environmentRequirements.map((requirement) => requirement.name),
    ).toEqual(["JWT_SECRET", "PORT"])
    expect(
      candidate?.environmentRequirements.every(
        (requirement) => requirement.sourceRoot === "backend",
      ),
    ).toBe(true)
  })
})

describe("assembleBackendDetection", () => {
  it("reports not-detected with no candidates", () => {
    const detection = assembleBackendDetection([null, null], [], true, false)

    expect(detection).toMatchObject({
      status: "not-detected",
      candidates: [],
    })
  })

  it("reports detected with multiple candidates in deterministic order", () => {
    const root = detectBackendCandidate(
      ".",
      packageJson({ dependencies: { express: "latest" } }),
      null,
      [],
      {},
    )
    const nested = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { fastify: "latest" } }),
      null,
      [],
      {},
    )
    const detection = assembleBackendDetection([root, nested], [], true, false)

    expect(detection.status).toBe("detected")
    expect(
      detection.candidates.map((candidate) => candidate.sourceRoot),
    ).toEqual([".", "backend"])
  })

  it("propagates warnings, complete, and truncated flags", () => {
    const detection = assembleBackendDetection(
      [null],
      ["a read failed"],
      false,
      true,
    )

    expect(detection.warnings).toContain("a read failed")
    expect(detection.complete).toBe(false)
    expect(detection.truncated).toBe(true)
  })
})

function packageJson(
  overrides: Partial<ParsedPackageJson> = {},
): ParsedPackageJson {
  return {
    name: null,
    dependencies: {},
    devDependencies: {},
    scripts: {},
    packageManager: null,
    workspaces: undefined,
    ...overrides,
  }
}
