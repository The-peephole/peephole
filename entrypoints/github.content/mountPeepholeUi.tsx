import { createRoot } from "react-dom/client"

import { PeepholeApp } from "../../components/PeepholeApp"
import type { RepositoryAnalysisLoader } from "../../types/analysis"
import type { RepositoryIdentity } from "../../types/repository"
import stylesheet from "./style.css?inline"

export const PEEPHOLE_HOST_ID = "peephole-extension-root"

export interface MountedPeepholeUi {
  element: HTMLElement
  unmount: () => void
}

export function mountPeepholeUi(
  target: HTMLElement,
  repository: RepositoryIdentity,
  loadRepositoryAnalysis: RepositoryAnalysisLoader,
): MountedPeepholeUi {
  document.querySelector<HTMLElement>("[data-peephole-container]")?.remove()

  const isListTarget = target.matches("ul, ol")
  const container = document.createElement(isListTarget ? "li" : "div")
  const host = isListTarget ? document.createElement("div") : container

  container.dataset.peepholeContainer = ""
  container.style.display = "inline-flex"
  container.style.position = "relative"
  host.id = PEEPHOLE_HOST_ID
  host.style.display = "inline-flex"
  host.style.position = "relative"

  if (target === document.body) {
    container.style.position = "fixed"
    container.style.right = "16px"
    container.style.top = "112px"
    container.style.zIndex = "2147483647"
  }

  const style = document.createElement("style")
  const appRoot = document.createElement("div")
  style.textContent = stylesheet
  host.append(style, appRoot)

  if (isListTarget) {
    container.append(host)
  }

  target.append(container)

  const reactRoot = createRoot(appRoot)
  reactRoot.render(
    <PeepholeApp
      loadRepositoryAnalysis={loadRepositoryAnalysis}
      repository={repository}
    />,
  )

  return {
    element: container,
    unmount: () => {
      reactRoot.unmount()
      container.remove()
    },
  }
}
