import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { createRepositoryAnalysisMessageLoader } from "../../core/analyzer/messages"
import { parseSidePanelRepository } from "../../core/sidepanel/messages"
import { SidePanelApp } from "./App"
import "./style.css"

const repository = parseSidePanelRepository(window.location.href)
const loadRepositoryAnalysis = createRepositoryAnalysisMessageLoader({
  send: (message) => browser.runtime.sendMessage(message),
})
const root = document.getElementById("root")

if (!root) {
  throw new Error("Peephole side panel root was not found.")
}

createRoot(root).render(
  <StrictMode>
    <SidePanelApp
      loadRepositoryAnalysis={loadRepositoryAnalysis}
      repository={repository}
    />
  </StrictMode>,
)
