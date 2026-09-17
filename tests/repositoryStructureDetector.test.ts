import { describe, expect, it } from "vitest"

import {
  MAX_STRUCTURE_PROJECT_CANDIDATES,
  classifyWorkspacePattern,
  detectRepositoryStructure,
  parsePackageJsonWorkspacePatterns,
  parsePnpmWorkspacePackages,
  planStructureCandidatePaths,
  type StructureCandidateProbe,
} from "../core/analyzer/repositoryStructureDetector"
import type { ParsedPackageJson } from "../core/analyzer/packageJson"

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

describe("parsePackageJsonWorkspacePatterns", () => {
  it("returns null patterns without a warning when workspaces is undeclared", () => {
    expect(parsePackageJsonWorkspacePatterns(undefined)).toEqual({
      patterns: null,
      warning: null,
    })
  })

  it("accepts the array form", () => {
    expect(parsePackageJsonWorkspacePatterns(["apps/*", "packages/*"])).toEqual(
      { patterns: ["apps/*", "packages/*"], warning: null },
    )
  })

  it("accepts the object form with a packages array", () => {
    expect(
      parsePackageJsonWorkspacePatterns({ packages: ["apps/*", "packages/*"] }),
    ).toEqual({ patterns: ["apps/*", "packages/*"], warning: null })
  })

  it("warns on an unsupported shape instead of guessing", () => {
    const result = parsePackageJsonWorkspacePatterns({ nohope: true })
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("unsupported shape")
  })

  it("warns on non-string entries", () => {
    const result = parsePackageJsonWorkspacePatterns(["apps/*", 42])
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("non-string entry")
  })

  it("warns on an empty array", () => {
    const result = parsePackageJsonWorkspacePatterns([])
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("empty")
  })
})

describe("parsePnpmWorkspacePackages", () => {
  it("parses the simple documented list form", () => {
    const content = ["packages:", '  - "apps/*"', '  - "packages/*"'].join("\n")
    expect(parsePnpmWorkspacePackages(content)).toEqual({
      patterns: ["apps/*", "packages/*"],
      warning: null,
    })
  })

  it("parses unquoted entries and trailing comments", () => {
    const content = ["packages:", "  - apps/* # frontend apps"].join("\n")
    expect(parsePnpmWorkspacePackages(content)).toEqual({
      patterns: ["apps/*"],
      warning: null,
    })
  })

  it("warns when no packages field exists", () => {
    const result = parsePnpmWorkspacePackages(
      "onlyBuiltDependencies:\n  - foo\n",
    )
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("could not be parsed")
  })

  it("warns on an unsupported entry shape instead of guessing", () => {
    const content = ["packages:", "  apps: true"].join("\n")
    const result = parsePnpmWorkspacePackages(content)
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("unsupported")
  })

  it("warns when the packages list is empty", () => {
    const content = ["packages:", "", "otherField: 1"].join("\n")
    const result = parsePnpmWorkspacePackages(content)
    expect(result.patterns).toBeNull()
    expect(result.warning).toContain("empty")
  })
})

describe("classifyWorkspacePattern", () => {
  it("classifies a dir/* pattern as wildcard", () => {
    expect(classifyWorkspacePattern("apps/*")).toEqual({
      kind: "wildcard",
      parentDir: "apps",
    })
  })

  it("classifies an exact one- or two-segment path as literal", () => {
    expect(classifyWorkspacePattern("frontend")).toEqual({
      kind: "literal",
      path: "frontend",
    })
    expect(classifyWorkspacePattern("apps/web")).toEqual({
      kind: "literal",
      path: "apps/web",
    })
  })

  it("rejects a negated pattern as unsupported", () => {
    expect(classifyWorkspacePattern("!apps/excluded").kind).toBe("unsupported")
  })

  it("rejects an absolute pattern as unsupported", () => {
    expect(classifyWorkspacePattern("/apps/*").kind).toBe("unsupported")
  })

  it("rejects '..' traversal as unsupported", () => {
    expect(classifyWorkspacePattern("../apps/*").kind).toBe("unsupported")
    expect(classifyWorkspacePattern("apps/../evil").kind).toBe("unsupported")
  })

  it("rejects a recursive ** pattern as unsupported", () => {
    expect(classifyWorkspacePattern("apps/**").kind).toBe("unsupported")
  })

  it("rejects a pattern deeper than two segments as unsupported", () => {
    expect(classifyWorkspacePattern("apps/web/nested").kind).toBe("unsupported")
    expect(classifyWorkspacePattern("apps/*/nested/*").kind).toBe("unsupported")
  })

  it("rejects a mid-pattern wildcard as unsupported", () => {
    expect(classifyWorkspacePattern("ap*/web").kind).toBe("unsupported")
  })
})

describe("planStructureCandidatePaths", () => {
  it("treats a wildcard-declared conventional directory as a container, not a bare literal", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: ["apps/*"],
      rootDirectories: ["apps", "packages"],
    })

    // "apps" comes from the declared wildcard; "packages" is folded into the
    // same container set purely from the conventional root directory name.
    // Neither is probed as a bare literal package.json.
    expect(plan.wildcardParents.sort()).toEqual(["apps", "packages"])
    expect(plan.literalPaths).toEqual([])
  })

  it("combines literal workspace declarations with conventional directories", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: ["frontend"],
      rootDirectories: ["frontend", "backend"],
    })

    expect(plan.literalPaths.sort()).toEqual(["backend", "frontend"])
  })

  it("collects unsupported patterns separately", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: ["apps/*", "!apps/excluded", "apps/web/nested"],
      rootDirectories: [],
    })

    expect(plan.wildcardParents).toEqual(["apps"])
    expect(plan.unsupportedPatterns).toEqual([
      "!apps/excluded",
      "apps/web/nested",
    ])
  })

  it("ignores conventional directory names Peephole does not recognize", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: [],
      rootDirectories: ["docs", "scripts"],
    })

    expect(plan.literalPaths).toEqual([])
    expect(plan.wildcardParents).toEqual([])
  })

  it("treats apps/packages as containers without any workspace declaration", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: [],
      rootDirectories: ["apps", "packages", "frontend"],
    })

    expect(plan.wildcardParents.sort()).toEqual(["apps", "packages"])
    expect(plan.literalPaths).toEqual(["frontend"])
  })

  it("does not duplicate a container already declared as a workspace wildcard", () => {
    const plan = planStructureCandidatePaths({
      workspacePatterns: ["apps/*"],
      rootDirectories: ["apps"],
    })

    expect(plan.wildcardParents).toEqual(["apps"])
  })
})

describe("detectRepositoryStructure", () => {
  function baseInput(overrides = {}) {
    return {
      rootFramework: "unknown" as const,
      rootPackageJsonPresent: false,
      rootPackageName: null,
      workspaceEvidence: [],
      warnings: [],
      candidates: [] as StructureCandidateProbe[],
      candidatePathsTruncated: false,
      directoryListingsTruncated: false,
      directoryListingFailed: false,
      ...overrides,
    }
  }

  it("reports a root-only Vite project as single-project", () => {
    const structure = detectRepositoryStructure(
      baseInput({ rootFramework: "react-vite", rootPackageJsonPresent: true }),
    )

    expect(structure.layout).toBe("single-project")
    expect(structure.projects).toEqual([
      {
        path: ".",
        isRoot: true,
        role: "project-candidate",
        hasPackageJson: true,
        packageName: null,
        evidence: [],
        warnings: [],
      },
    ])
    expect(structure.complete).toBe(true)
    expect(structure.truncated).toBe(false)
  })

  it("reports a package-free static root as single-project", () => {
    const structure = detectRepositoryStructure(
      baseInput({ rootFramework: "static" }),
    )

    expect(structure.layout).toBe("single-project")
    expect(structure.projects[0]?.role).toBe("project-candidate")
  })

  it("reports unknown layout when no meaningful evidence exists anywhere", () => {
    const structure = detectRepositoryStructure(baseInput())

    expect(structure.layout).toBe("unknown")
    expect(structure.projects).toHaveLength(1)
    expect(structure.projects[0]).toMatchObject({ path: ".", role: "unknown" })
  })

  it("classifies frontend/backend candidates as multi-project without a workspace tool", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        rootFramework: "unknown",
        candidates: [
          {
            path: "frontend",
            packageJson: packageJson({ dependencies: { react: "latest" } }),
            parseError: null,
            requestError: null,
          },
          {
            path: "backend",
            packageJson: packageJson({ dependencies: { express: "latest" } }),
            parseError: null,
            requestError: null,
          },
        ],
      }),
    )

    expect(structure.layout).toBe("multi-project")
    const paths = structure.projects.map((project) => project.path)
    expect(paths).toEqual([".", "frontend", "backend"])
    expect(structure.projects.find((p) => p.path === "frontend")?.role).toBe(
      "project-candidate",
    )
    // "backend" has no frontend-framework evidence, so its role stays
    // conservative rather than claiming backend support.
    expect(structure.projects.find((p) => p.path === "backend")?.role).toBe(
      "unknown",
    )
  })

  it("reports workspace layout when workspace tool evidence exists", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        workspaceEvidence: ["package.json workspaces detected"],
        candidates: [
          {
            path: "apps/web",
            packageJson: packageJson({ dependencies: { vite: "latest" } }),
            parseError: null,
            requestError: null,
          },
        ],
      }),
    )

    expect(structure.layout).toBe("workspace")
    expect(structure.projects.map((p) => p.path)).toEqual([".", "apps/web"])
  })

  it("classifies a packages/* candidate as a package candidate even with a frontend dependency", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        workspaceEvidence: ["package.json workspaces detected"],
        candidates: [
          {
            path: "packages/ui",
            packageJson: packageJson({
              name: "@acme/ui",
              dependencies: { react: "latest" },
            }),
            parseError: null,
            requestError: null,
          },
        ],
      }),
    )

    const candidate = structure.projects.find((p) => p.path === "packages/ui")
    expect(candidate?.role).toBe("package-candidate")
    expect(candidate?.packageName).toBe("@acme/ui")
  })

  it("keeps a malformed nested package.json as an unknown candidate with a warning instead of failing", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        workspaceEvidence: ["package.json workspaces detected"],
        candidates: [
          {
            path: "apps/web",
            packageJson: packageJson({ dependencies: { vite: "latest" } }),
            parseError: null,
            requestError: null,
          },
          {
            path: "apps/admin",
            packageJson: null,
            parseError: "package.json contains invalid JSON.",
            requestError: null,
          },
        ],
      }),
    )

    const web = structure.projects.find((p) => p.path === "apps/web")
    const admin = structure.projects.find((p) => p.path === "apps/admin")

    expect(web?.role).toBe("project-candidate")
    expect(admin).toMatchObject({
      role: "unknown",
      hasPackageJson: true,
      warnings: ["package.json contains invalid JSON."],
    })
    expect(structure.complete).toBe(true)
  })

  it("marks the result incomplete when a candidate request fails", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        candidates: [
          {
            path: "backend",
            packageJson: null,
            parseError: null,
            requestError: "GitHub API rate limit reached.",
          },
        ],
      }),
    )

    expect(structure.complete).toBe(false)
    expect(structure.warnings.some((w) => w.includes("rate limit"))).toBe(true)
    // A failed probe never becomes a candidate.
    expect(structure.projects.map((p) => p.path)).toEqual(["."])
  })

  it("silently drops a candidate whose package.json is absent", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        candidates: [
          {
            path: "docs",
            packageJson: null,
            parseError: null,
            requestError: null,
          },
        ],
      }),
    )

    expect(structure.projects.map((p) => p.path)).toEqual(["."])
  })

  it("propagates directory-listing and candidate-path truncation flags", () => {
    const listingTruncated = detectRepositoryStructure(
      baseInput({ directoryListingsTruncated: true }),
    )
    const pathsTruncated = detectRepositoryStructure(
      baseInput({ candidatePathsTruncated: true }),
    )

    expect(listingTruncated.truncated).toBe(true)
    expect(pathsTruncated.truncated).toBe(true)
  })

  it("marks the result incomplete (not just truncated) when a directory listing itself failed", () => {
    const structure = detectRepositoryStructure(
      baseInput({ directoryListingFailed: true }),
    )

    expect(structure.complete).toBe(false)
    // A listing failure alone is not the same signal as hitting a bound.
    expect(structure.truncated).toBe(false)
  })

  it("keeps other candidates when only one directory listing failed", () => {
    const structure = detectRepositoryStructure(
      baseInput({
        directoryListingFailed: true,
        warnings: ["apps could not be listed: not found"],
        candidates: [
          {
            path: "packages/ui",
            packageJson: packageJson({ name: "@acme/ui" }),
            parseError: null,
            requestError: null,
          },
        ],
      }),
    )

    expect(structure.complete).toBe(false)
    expect(structure.projects.map((p) => p.path)).toEqual([".", "packages/ui"])
    expect(
      structure.warnings.some((w) => w.includes("apps could not be listed")),
    ).toBe(true)
  })

  it("bounds the surfaced project list and reports truncation", () => {
    const candidates: StructureCandidateProbe[] = Array.from(
      { length: MAX_STRUCTURE_PROJECT_CANDIDATES + 5 },
      (_, index) => ({
        path: `apps/app-${index}`,
        packageJson: packageJson({ dependencies: { vite: "latest" } }),
        parseError: null,
        requestError: null,
      }),
    )

    const structure = detectRepositoryStructure(baseInput({ candidates }))

    expect(structure.projects.length).toBe(MAX_STRUCTURE_PROJECT_CANDIDATES)
    expect(structure.truncated).toBe(true)
  })
})
