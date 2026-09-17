import { describe, expect, it } from "vitest"

import {
  assembleBackendDetection,
  backendPackageJsonParseWarning,
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
      [],
      {},
    )

    expect(candidate?.framework).toBe("unknown")
    expect(candidate?.databaseDependencies).toEqual(["pg"])
  })

  it("still detects a candidate (framework unknown) from a real, parsed database dependency", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { pg: "latest" } }),
      [],
      {},
    )

    expect(candidate).not.toBeNull()
    expect(candidate?.framework).toBe("unknown")
    expect(candidate?.databaseDependencies).toEqual(["pg"])
    expect(candidate?.evidence.join(" ")).toContain(
      "Database/server-side dependency detected",
    )
  })

  it("preserves database/server dependency evidence alongside a confirmed framework", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest", pg: "latest" } }),
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
      [],
      {},
    )
    const firebase = detectBackendCandidate(
      "app",
      packageJson({ dependencies: { firebase: "latest" } }),
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
      [],
      {},
    )

    expect(candidate?.framework).toBe("express")
    expect(candidate?.warnings.join(" ")).toContain("Hosted backend client")
  })

  it("does not confirm a backend from a directory with no usable package.json (absent or unparseable)", () => {
    // detectBackendCandidate cannot -- and does not need to -- distinguish
    // "no package.json" from "a package.json that failed to parse": both
    // reach this function as packageJson === null, and neither is backend
    // evidence. A parse failure is instead surfaced by the caller as a
    // BackendDetection-level warning + complete: false (see
    // backendPackageJsonParseWarning and tests/backendCandidateLoader.test.ts
    // / tests/analyzeRepository.test.ts), never as a fabricated candidate.
    const candidate = detectBackendCandidate("backend", null, [], {})

    expect(candidate).toBeNull()
  })

  it("does not mislabel a frontend-only candidate as backend", () => {
    const candidate = detectBackendCandidate(
      "frontend",
      packageJson({ dependencies: { react: "latest", vite: "latest" } }),
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
      [],
      {},
    )

    expect(candidate?.entrypoint).toBe("src/index.ts")
  })

  it("never creates a candidate from a conventional backend directory name plus only a malformed package.json", () => {
    // Same as the "absent or unparseable" case above, phrased explicitly
    // against the false-positive this guards: a directory literally named
    // "backend" must not become "detected" just because *some*
    // package.json (even an unparseable one) exists there.
    const candidate = detectBackendCandidate("backend", null, [], {})

    expect(candidate).toBeNull()
  })

  it("adds conventional directory-name evidence only alongside a qualifying candidate", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest" } }),
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
      [],
      {},
    )

    expect(candidate?.sourceRoot).toBe(".")
  })

  it("preserves a nested workspace sourceRoot", () => {
    const candidate = detectBackendCandidate(
      "apps/api",
      packageJson({ dependencies: { fastify: "latest" } }),
      [],
      {},
    )

    expect(candidate?.sourceRoot).toBe("apps/api")
  })

  it("classifies its own environment template scoped to its sourceRoot", () => {
    const candidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest" } }),
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

describe("backendPackageJsonParseWarning", () => {
  it("names the repository root package.json without a leading './'", () => {
    expect(backendPackageJsonParseWarning(".", "invalid JSON")).toBe(
      "package.json could not be parsed: invalid JSON",
    )
  })

  it("names a nested candidate's package.json by its source root", () => {
    expect(backendPackageJsonParseWarning("backend", "invalid JSON")).toBe(
      "backend/package.json could not be parsed: invalid JSON",
    )
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
      [],
      {},
    )
    const nested = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { fastify: "latest" } }),
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

  it("reports not-detected, complete: false, with the parse-error warning for a malformed-only candidate", () => {
    // Mirrors how a caller (BackendCandidateLoader / analyzeRepository)
    // handles a malformed package.json: detectBackendCandidate never sees
    // the parse error and returns null; the caller pushes the warning and
    // marks the result incomplete itself.
    const warning = backendPackageJsonParseWarning(
      "backend",
      "package.json contains invalid JSON.",
    )
    const detection = assembleBackendDetection([null], [warning], false, false)

    expect(detection.status).toBe("not-detected")
    expect(detection.complete).toBe(false)
    expect(detection.warnings).toContain(warning)
  })

  it("keeps a valid sibling candidate detected alongside a malformed candidate's warning", () => {
    const expressCandidate = detectBackendCandidate(
      "backend",
      packageJson({ dependencies: { express: "latest" } }),
      [],
      {},
    )
    const warning = backendPackageJsonParseWarning(
      "broken-service",
      "package.json contains invalid JSON.",
    )
    const detection = assembleBackendDetection(
      [expressCandidate, null],
      [warning],
      false,
      false,
    )

    expect(detection.status).toBe("detected")
    expect(detection.candidates).toMatchObject([
      { sourceRoot: "backend", framework: "express" },
    ])
    expect(detection.complete).toBe(false)
    expect(detection.warnings).toContain(warning)
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
