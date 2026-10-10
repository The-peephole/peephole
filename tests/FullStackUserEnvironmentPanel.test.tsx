// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewPanel } from "../components/FullStackPreviewPanel"
import { UserEnvironmentEnabledContext } from "../components/userEnvironmentContext"
import type { FullStackPreviewApi } from "../core/fullstack/apiClient"
import { FullStackPreviewApiError } from "../core/fullstack/apiClient"
import { toRootBuildTargetAnalysis } from "../core/preview/buildAdapters"
import type { BuildTargetAnalysis, RepositoryAnalysis } from "../types/analysis"
import type { BackendCandidate } from "../types/backend"
import type { EnvironmentRequirement } from "../types/environment"
import type { FullStackPreview } from "../types/fullstackPreview"
import { supportedAnalysis } from "./analysisFixture"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"

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

const backend: BackendCandidate = {
  sourceRoot: "backend",
  framework: "express",
  runtime: "node",
  packageName: "fixture-backend",
  packageManager: "npm@10.0.0",
  entrypoint: "src/server.js",
  databaseDependencies: ["pg"],
  environmentRequirements: [
    requirement("PORT", {
      requirementKind: "auto-configurable",
      sensitivity: "public",
    }),
    requirement("SESSION_SECRET", {
      requirementKind: "preview-generated-candidate",
      sensitivity: "secret-like",
    }),
    requirement("DATABASE_URL", {
      requirementKind: "database-requirement",
      sensitivity: "secret-like",
    }),
    requirement("APP_GREETING"),
    requirement("FEATURE_MODE"),
  ],
  packageLockPresent: true,
  evidence: [],
  warnings: [],
}

const externalKeyBackend: BackendCandidate = {
  ...backend,
  environmentRequirements: [
    ...backend.environmentRequirements,
    requirement("OPENAI_API_KEY", {
      requirementKind: "user-required",
      sensitivity: "secret-like",
    }),
  ],
}

function createAnalysis(
  candidates: BackendCandidate[],
): BuildTargetAnalysis & RepositoryAnalysis {
  const repositoryAnalysis: RepositoryAnalysis = {
    ...supportedAnalysis,
    backend: {
      status: "detected",
      candidates,
      evidence: [],
      warnings: [],
      complete: true,
      truncated: false,
    },
  }
  return {
    ...repositoryAnalysis,
    ...toRootBuildTargetAnalysis(repositoryAnalysis),
  }
}

const analysis = createAnalysis([backend])
const queued: FullStackPreview = {
  id: "fullstack-12345678-1234-1234-1234-123456789abc",
  repository: {
    repositoryId: analysis.repository.repositoryId,
    owner: analysis.repository.owner,
    name: analysis.repository.repo,
    commitSha: analysis.repository.commitSha,
  },
  frontendSourceRoot: analysis.target.sourceRoot,
  backendSourceRoot: "backend",
  status: "queued",
  url: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  expiresAt: "2026-10-08T00:15:00.000Z",
}

function createApi(
  overrides: Partial<FullStackPreviewApi> = {},
): FullStackPreviewApi {
  return {
    create: vi.fn().mockResolvedValue(queued),
    get: vi.fn().mockResolvedValue(queued),
    stop: vi.fn().mockResolvedValue({ ...queued, status: "cancelled" }),
    ...overrides,
  }
}

describe("FullStackPreviewPanel user-provided configuration (M12)", () => {
  const roots: Root[] = []
  let setItem: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(queued.createdAt))
    setItem = vi.spyOn(Storage.prototype, "setItem")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots) act(() => root.unmount())
    roots.length = 0
    document.body.innerHTML = ""
  })

  async function render(
    api: FullStackPreviewApi,
    options: { enabled?: boolean; value?: typeof analysis } = {},
  ) {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const element = (value: typeof analysis) => (
      <UserEnvironmentEnabledContext.Provider value={options.enabled ?? true}>
        <FullStackPreviewPanel
          analysis={value}
          fullStackPreviewApi={api}
          getSession={() =>
            Promise.resolve({
              token: "peephole-session",
              expiresAt: "2099-01-01T00:00:00.000Z",
            })
          }
          pollIntervalMs={60_000}
        />
      </UserEnvironmentEnabledContext.Provider>
    )
    await act(async () => root.render(element(options.value ?? analysis)))
    return {
      container,
      rerender: async (value: typeof analysis) =>
        act(async () => root.render(element(value))),
    }
  }

  const input = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
  const runButton = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Run full-stack preview"),
    )

  async function type(element: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(element, value)
      element.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  async function confirm(container: HTMLElement) {
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!
    await act(async () => checkbox.click())
  }

  it("classifies every declared variable and offers input only for configurable ones", async () => {
    const { container } = await render(createApi())
    const text = container.textContent ?? ""
    expect(text).toContain("PORT: Peephole — Auto-configured")
    expect(text).toContain("SESSION_SECRET: Peephole — Generated automatically")
    expect(text).toContain("DATABASE_URL: Peephole — Temporary database")
    expect(text).toContain("Do not enter API keys, passwords, or tokens.")
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input[type="text"]'),
        (element) => element.name,
      ),
    ).toEqual(["APP_GREETING", "FEATURE_MODE"])
    const greeting = input(container, "APP_GREETING")!
    expect(greeting.labels?.[0]?.textContent).toContain("APP_GREETING")
    expect(greeting.autocomplete).toBe("off")
    expect(greeting.getAttribute("aria-invalid")).toBe("true")
    expect(text).toContain("A value for APP_GREETING is required.")
  })

  it("requires every value and the confirmation before Run, then submits exactly the entries", async () => {
    const api = createApi()
    const { container } = await render(api)
    expect(runButton(container)?.disabled).toBe(true)

    await type(input(container, "APP_GREETING")!, SENTINEL)
    expect(runButton(container)?.disabled).toBe(true)
    await type(input(container, "FEATURE_MODE")!, "demo")
    expect(runButton(container)?.disabled).toBe(true)
    await confirm(container)
    expect(runButton(container)?.disabled).toBe(false)

    await act(async () => runButton(container)!.click())
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        backendSourceRoot: "backend",
        userEnvironment: [
          { name: "APP_GREETING", value: SENTINEL },
          { name: "FEATURE_MODE", value: "demo" },
        ],
      }),
      expect.anything(),
    )
    // After admission the local copy is gone and nothing was persisted.
    expect(container.innerHTML).not.toContain(SENTINEL)
    expect(input(container, "APP_GREETING")).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
  })

  it("rejects a control character locally with a value-free message", async () => {
    const { container } = await render(createApi())
    await type(input(container, "APP_GREETING")!, `${SENTINEL}${"\t"}x`)
    await type(input(container, "FEATURE_MODE")!, "demo")
    await confirm(container)
    expect(runButton(container)?.disabled).toBe(true)
    const errorText = document.getElementById(
      `${input(container, "APP_GREETING")!.id}-error`,
    )?.textContent
    expect(errorText).toContain("APP_GREETING")
    expect(errorText).not.toContain(SENTINEL)
  })

  it("never shows submitted values in a request error", async () => {
    const api = createApi({
      create: vi
        .fn()
        .mockRejectedValue(
          new FullStackPreviewApiError(
            "INVALID_REQUEST",
            "A value for FEATURE_MODE is required.",
            400,
          ),
        ),
    })
    const { container } = await render(api)
    await type(input(container, "APP_GREETING")!, SENTINEL)
    await type(input(container, "FEATURE_MODE")!, "demo")
    await confirm(container)
    await act(async () => runButton(container)!.click())
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(
      "A value for FEATURE_MODE is required.",
    )
    expect(alert?.textContent).not.toContain(SENTINEL)
  })

  it("issues a new idempotency key when a value changes after a failed attempt", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new FullStackPreviewApiError("NETWORK_ERROR", "unreachable"),
      )
      .mockResolvedValue(queued)
    const { container } = await render(createApi({ create }))
    await type(input(container, "APP_GREETING")!, "first")
    await type(input(container, "FEATURE_MODE")!, "demo")
    await confirm(container)
    await act(async () => runButton(container)!.click())
    // Retry with unchanged values reuses the key...
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    )!
    await act(async () => retry.click())
    expect(create.mock.calls[1]![1].idempotencyKey).toBe(
      create.mock.calls[0]![1].idempotencyKey,
    )
  })

  it("clears values when the commit or target changes", async () => {
    const { container, rerender } = await render(createApi())
    await type(input(container, "APP_GREETING")!, SENTINEL)
    await rerender({
      ...analysis,
      repository: { ...analysis.repository, commitSha: "b".repeat(40) },
    })
    expect(input(container, "APP_GREETING")?.value).toBe("")
    expect(container.innerHTML).not.toContain(SENTINEL)
  })

  it("offers no input for an external API key and keeps the backend ineligible", async () => {
    const api = createApi()
    const { container } = await render(api, {
      value: createAnalysis([externalKeyBackend]),
    })
    expect(input(container, "OPENAI_API_KEY")).toBeNull()
    expect(container.textContent).toContain(
      'Environment requirement "OPENAI_API_KEY" is not supported',
    )
    expect(runButton(container)).toBeUndefined()
  })

  it("keeps a configurable backend ineligible and inputless when the build flag is off", async () => {
    const { container } = await render(createApi(), { enabled: false })
    expect(input(container, "APP_GREETING")).toBeNull()
    expect(container.textContent).toContain(
      "declares configuration variables that need user-provided values",
    )
    expect(runButton(container)).toBeUndefined()
  })
})
