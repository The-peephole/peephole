import { describe, expect, it } from "vitest"

import { analyzeRepository } from "../core/analyzer/analyzeRepository"
import type { RepositoryFileSnapshot } from "../core/github/knownFiles"
import type { RepositoryMetadata } from "../types/repository"

const repository: RepositoryMetadata = {
  repositoryId: 1,
  owner: "example",
  repo: "app",
  defaultBranch: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  homepage: null,
}

describe("analyzeRepository", () => {
  it("marks a root React Vite app with a frozen npm build as compatible", () => {
    const analysis = analyzeRepository(
      repository,
      snapshot(
        {
          "package.json": packageJson({
            dependencies: { react: "latest" },
            devDependencies: { vite: "latest", typescript: "latest" },
            scripts: { dev: "vite", build: "vite build" },
          }),
          "vite.config.ts":
            "export default { build: { outDir: 'public-build' } }",
          ".env.example": "VITE_API_URL=https://example.test\n",
        },
        ["package-lock.json", "index.html", "tsconfig.json"],
      ),
    )

    expect(analysis.technologies).toMatchObject({
      framework: "react-vite",
      typescript: true,
    })
    expect(analysis.packageManager).toBe("npm")
    expect(analysis.runtime).toMatchObject({
      installCommand: "npm ci",
      devCommand: "npm run dev",
      buildCommand: "npm run build",
      outputDirectory: "public-build",
    })
    expect(analysis.environment.variables).toEqual(["VITE_API_URL"])
    expect(analysis.environment.publicClientVariables).toEqual(["VITE_API_URL"])
    expect(analysis.preview).toMatchObject({
      mode: "native-static-build",
      blockers: [],
    })
  })

  it.each([
    [{ vue: "latest" }, "vue-vite"],
    [
      { svelte: "latest", "@sveltejs/vite-plugin-svelte": "latest" },
      "svelte-vite",
    ],
  ] as const)("detects a %s Vite app", (dependencies, expectedFramework) => {
    const analysis = analyzeRepository(
      repository,
      snapshot(
        {
          "package.json": packageJson({
            dependencies,
            devDependencies: { vite: "latest" },
            scripts: { build: "vite build" },
          }),
        },
        ["pnpm-lock.yaml", "index.html"],
      ),
    )

    expect(analysis.technologies.framework).toBe(expectedFramework)
    expect(analysis.packageManager).toBe("pnpm")
    expect(analysis.preview.mode).toBe("native-static-build")
  })

  it("supports a package-free static root", () => {
    const analysis = analyzeRepository(repository, snapshot({}, ["index.html"]))

    expect(analysis.technologies.framework).toBe("static")
    expect(analysis.packageManager).toBe("none")
    expect(analysis.runtime.outputDirectory).toBe(".")
    expect(analysis.preview.mode).toBe("native-static-build")
  })

  it("blocks secret-like environment declarations without retaining values", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({
        ".env.example": [
          "# ignored",
          "VITE_PUBLIC_URL=https://example.test",
          "DATABASE_URL=postgres://secret-value",
          "export API_TOKEN=secret-value",
          "MARKETPLACE_PAT=secret-value",
        ].join("\n"),
      }),
    )

    expect(analysis.environment.variables).toEqual([
      "API_TOKEN",
      "DATABASE_URL",
      "MARKETPLACE_PAT",
      "VITE_PUBLIC_URL",
    ])
    expect(analysis.environment.secretLikeVariables).toEqual([
      "API_TOKEN",
      "DATABASE_URL",
      "MARKETPLACE_PAT",
    ])
    expect(analysis.environment.publicClientVariables).toEqual([
      "VITE_PUBLIC_URL",
    ])
    expect(analysis.preview.mode).toBe("unsupported")
    expect(blockerCodes(analysis)).toContain("SECRET_ENV_REQUIRED")
    expect(JSON.stringify(analysis)).not.toContain("secret-value")
  })

  it("blocks Next.js because persistent server execution is deferred", () => {
    const analysis = analyzeRepository(
      repository,
      snapshot(
        {
          "package.json": packageJson({
            dependencies: { next: "latest", react: "latest" },
            scripts: { build: "next build" },
          }),
        },
        ["package-lock.json", "next.config.js"],
      ),
    )

    expect(analysis.technologies.framework).toBe("next")
    expect(analysis.preview.mode).toBe("unsupported")
    expect(blockerCodes(analysis)).toContain("PERSISTENT_SERVER_REQUIRED")
  })

  it("identifies WXT browser extensions with an explicit blocker", () => {
    const analysis = analyzeRepository(
      repository,
      snapshot(
        {
          "package.json": packageJson({
            dependencies: { react: "latest" },
            devDependencies: { typescript: "latest", wxt: "latest" },
            scripts: { dev: "wxt", build: "wxt build" },
          }),
        },
        ["package-lock.json", "tsconfig.json"],
      ),
    )

    expect(analysis.technologies.framework).toBe("wxt")
    expect(analysis.preview.mode).toBe("unsupported")
    expect(analysis.preview.blockers).toContainEqual({
      code: "UNSUPPORTED_FRAMEWORK",
      message:
        "WXT browser extensions require browser extension APIs and are outside the static v0.1 preview contract.",
    })
  })

  it("blocks ambiguous workspaces", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({}, { workspaces: ["apps/*"] }),
    )

    expect(analysis.workspace).toMatchObject({
      monorepo: true,
      ambiguous: true,
    })
    expect(blockerCodes(analysis)).toContain("AMBIGUOUS_WORKSPACE")
  })

  it("blocks conflicting lockfiles", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({}, {}, ["package-lock.json", "pnpm-lock.yaml"]),
    )

    expect(analysis.packageManager).toBe("unknown")
    expect(blockerCodes(analysis)).toContain("CONFLICTING_LOCKFILES")
  })

  it("reports malformed package.json as evidence instead of guessing", () => {
    const analysis = analyzeRepository(
      repository,
      snapshot({ "package.json": "{" }, ["index.html", "package-lock.json"]),
    )

    expect(analysis.technologies.framework).toBe("unknown")
    expect(analysis.preview.mode).toBe("unsupported")
    expect(blockerCodes(analysis)).toEqual(
      expect.arrayContaining([
        "MALFORMED_PACKAGE_JSON",
        "UNSUPPORTED_FRAMEWORK",
      ]),
    )
  })

  it("blocks server and database dependencies", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({}, { dependencies: { express: "latest", pg: "latest" } }),
    )

    expect(blockerCodes(analysis)).toContain("BACKEND_REQUIRED")
  })

  it("blocks a dynamic Vite output directory instead of guessing", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({
        "vite.config.ts":
          "export default { build: { outDir: process.env.BUILD_DIR } }",
      }),
    )

    expect(analysis.runtime.outputDirectory).toBeNull()
    expect(blockerCodes(analysis)).toContain("UNKNOWN_OUTPUT_DIRECTORY")
  })

  it("marks a provider config without a URL as configured", () => {
    const analysis = analyzeRepository(
      repository,
      viteSnapshot({}, {}, ["vercel.json"]),
    )

    expect(analysis.deployment).toMatchObject({
      status: "configured",
      provider: "vercel",
      url: null,
    })
    expect(analysis.preview.mode).toBe("native-static-build")
  })

  it("uses a safe repository homepage as a confirmed deployment", () => {
    const analysis = analyzeRepository(
      { ...repository, homepage: "https://example.vercel.app/" },
      viteSnapshot(),
    )

    expect(analysis.deployment).toMatchObject({
      status: "confirmed",
      provider: "homepage",
      url: "https://example.vercel.app/",
    })
    expect(analysis.preview.mode).toBe("existing-deployment")
  })

  it.each([
    ["package-lock.json", "npm", "npm ci"],
    ["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun", "bun install --frozen-lockfile"],
  ] as const)(
    "selects %s deterministically",
    (lockfile, expectedManager, expectedInstall) => {
      const analysis = analyzeRepository(
        repository,
        snapshot(
          {
            "package.json": packageJson({
              dependencies: { react: "latest" },
              devDependencies: { vite: "latest" },
              scripts: { build: "vite build" },
            }),
          },
          [lockfile, "index.html"],
        ),
      )

      expect(analysis.packageManager).toBe(expectedManager)
      expect(analysis.runtime.installCommand).toBe(expectedInstall)
      expect(analysis.preview.mode).toBe("native-static-build")
    },
  )
})

function viteSnapshot(
  extraTextFiles: Record<string, string> = {},
  extraPackageJson: Record<string, unknown> = {},
  extraPaths: string[] = [],
): RepositoryFileSnapshot {
  return snapshot(
    {
      "package.json": packageJson({
        dependencies: { react: "latest" },
        devDependencies: { vite: "latest" },
        scripts: { dev: "vite", build: "vite build" },
        ...extraPackageJson,
      }),
      ...extraTextFiles,
    },
    ["package-lock.json", "index.html", ...extraPaths],
  )
}

function snapshot(
  textFiles: Record<string, string>,
  extraPaths: string[] = [],
): RepositoryFileSnapshot {
  return {
    presentPaths: Array.from(
      new Set([...Object.keys(textFiles), ...extraPaths]),
    ).sort(),
    textFiles,
    warnings: [],
    complete: true,
  }
}

function packageJson(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function blockerCodes(
  analysis: ReturnType<typeof analyzeRepository>,
): string[] {
  return analysis.preview.blockers.map((blocker) => blocker.code)
}
