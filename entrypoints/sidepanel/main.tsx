import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { createRepositoryAnalysisMessageLoader } from "../../core/analyzer/messages"
import { PreviewApiClient } from "../../core/preview/apiClient"
import { parsePreviewApiBaseUrl } from "../../core/preview/config"
import { parseSidePanelRepository } from "../../core/sidepanel/messages"
import { SidePanelApp } from "./App"
import "./style.css"

const repository = parseSidePanelRepository(window.location.href)
const loadRepositoryAnalysis = createRepositoryAnalysisMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
let previewApi: PreviewApiClient | null = null
let previewConfigurationError: string | null = null

try {
  const previewApiBaseUrl = parsePreviewApiBaseUrl(
    import.meta.env.WXT_PREVIEW_API_BASE_URL,
  )
  previewApi = previewApiBaseUrl
    ? new PreviewApiClient(previewApiBaseUrl)
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

createRoot(root).render(
  <StrictMode>
    <SidePanelApp
      loadRepositoryAnalysis={loadRepositoryAnalysis}
      previewApi={previewApi}
      previewConfigurationError={previewConfigurationError}
      repository={repository}
    />
  </StrictMode>,
)
