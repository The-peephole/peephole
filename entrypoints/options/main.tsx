import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { parsePreviewApiBaseUrl } from "../../core/preview/config"
import { OptionsApp } from "./App"
import "./style.css"

let previewApiBaseUrl: string | null = null
let configurationError: string | null = null
try {
  previewApiBaseUrl = parsePreviewApiBaseUrl(
    import.meta.env.WXT_PREVIEW_API_BASE_URL,
  )
} catch (error) {
  configurationError =
    error instanceof Error
      ? error.message
      : "Preview service configuration is invalid."
}

const root = document.getElementById("root")

if (!root) {
  throw new Error("Peephole options root was not found.")
}

createRoot(root).render(
  <StrictMode>
    <OptionsApp
      configurationError={configurationError}
      previewApiBaseUrl={previewApiBaseUrl}
    />
  </StrictMode>,
)
