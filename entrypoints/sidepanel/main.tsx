import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { createRepositoryAnalysisMessageLoader } from "../../core/analyzer/messages"
import { createBuildTargetAnalysisMessageLoader } from "../../core/analyzer/targetMessages"
import { BackendRuntimeApiClient } from "../../core/backendRuntime/apiClient"
import { createRepositoryBranchesMessageLoader } from "../../core/github/branchMessages"
import { createLiveDeploymentMessageLoader } from "../../core/github/liveDeploymentMessages"
import { PreviewApiClient } from "../../core/preview/apiClient"
import {
  parsePreviewApiBaseUrl,
  parsePreviewArtifactBaseDomain,
} from "../../core/preview/config"
import { connectGitHub } from "../../core/preview/githubConnection"
import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
} from "../../core/preview/sessionStorage"
import {
  parseSidePanelRepository,
  parseSidePanelTabId,
} from "../../core/sidepanel/messages"
import {
  createGitHubThemeMessageClient,
  subscribeToGitHubThemeUpdates,
} from "../../core/sidepanel/themeMessages"
import { SidePanelApp } from "./App"
import { SidePanelThemeController } from "./SidePanelThemeController"
import "./style.css"

const repository = parseSidePanelRepository(window.location.href)
const sourceTabId = parseSidePanelTabId(window.location.href)
const loadRepositoryAnalysis = createRepositoryAnalysisMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
const loadBuildTargetAnalysis = createBuildTargetAnalysisMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
const loadRepositoryBranches = createRepositoryBranchesMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
const loadRepositoryLiveDeployment = createLiveDeploymentMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
let previewApi: PreviewApiClient | null = null
let backendRuntimeApi: BackendRuntimeApiClient | null = null
let reconnectGitHub: (() => Promise<void>) | null = null
let previewArtifactBaseDomain: string | null = null
let previewConfigurationError: string | null = null
// Production deliberately leaves this false. This is separate from preview
// API configuration so a static-preview deployment can never advertise an
// unwired /v1/backend-runtimes endpoint.
const backendRuntimeEnabled =
  import.meta.env.WXT_BACKEND_RUNTIME_ENABLED === "true"

try {
  const previewApiBaseUrl = parsePreviewApiBaseUrl(
    import.meta.env.WXT_PREVIEW_API_BASE_URL,
  )
  previewArtifactBaseDomain = parsePreviewArtifactBaseDomain(
    import.meta.env.WXT_PREVIEW_ARTIFACT_BASE_DOMAIN,
  )
  previewApi = previewApiBaseUrl
    ? new PreviewApiClient(previewApiBaseUrl, {
        getSession: getStoredPreviewSession,
        clearSession: clearStoredPreviewSession,
      })
    : null
  // Same control-plane origin as the preview API (already covered by its
  // host permission) -- backend-v1 is a separate resource on that host,
  // not a separate service.
  backendRuntimeApi =
    backendRuntimeEnabled && previewApiBaseUrl
      ? new BackendRuntimeApiClient(previewApiBaseUrl, {
          getSession: getStoredPreviewSession,
          clearSession: clearStoredPreviewSession,
        })
      : null
  reconnectGitHub = previewApiBaseUrl
    ? async () => {
        await connectGitHub(previewApiBaseUrl)
      }
    : null
} catch (error) {
  previewConfigurationError =
    error instanceof Error
      ? error.message
      : "Preview service configuration is invalid."
}
const root = document.getElementById("root")

if (!root) {
  throw new Error("Peephole side panel root was not found.")
}

if (sourceTabId !== null) {
  const themeMessages = createGitHubThemeMessageClient({
    send: (message) => browser.runtime.sendMessage(message),
  })
  const themeController = new SidePanelThemeController(
    document.documentElement,
    sourceTabId,
    {
      load: themeMessages.load,
      subscribe: (tabId, onThemeChange) =>
        subscribeToGitHubThemeUpdates(
          browser.runtime.onMessage,
          tabId,
          onThemeChange,
        ),
    },
  )
  themeController.start()
  window.addEventListener("pagehide", () => themeController.stop(), {
    once: true,
  })
}

createRoot(root).render(
  <StrictMode>
    <SidePanelApp
      loadRepositoryAnalysis={loadRepositoryAnalysis}
      loadBuildTargetAnalysis={loadBuildTargetAnalysis}
      loadRepositoryBranches={loadRepositoryBranches}
      loadRepositoryLiveDeployment={loadRepositoryLiveDeployment}
      backendRuntimeApi={backendRuntimeApi}
      backendRuntimeEnabled={backendRuntimeEnabled}
      connectGitHub={reconnectGitHub}
      previewApi={previewApi}
      previewArtifactBaseDomain={previewArtifactBaseDomain}
      previewConfigurationError={previewConfigurationError}
      repository={repository}
    />
  </StrictMode>,
)
