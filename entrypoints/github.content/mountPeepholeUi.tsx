import { createRoot } from "react-dom/client"

import { PeepholeApp } from "../../components/PeepholeApp"
import type { RepositoryIdentity } from "../../types/repository"
import stylesheet from "./style.css?inline"
import { findPeepholeInjectionTarget } from "./githubDom"

export const PEEPHOLE_HOST_ID = "peephole-extension-root"

export interface MountedPeepholeUi {
  element: HTMLElement
  isIntact: () => boolean
  unmount: () => void
}

export function mountPeepholeUi(
  target: HTMLElement,
  repository: RepositoryIdentity,
  openSidePanel: (repository: RepositoryIdentity) => Promise<void>,
  logoUrl = browser.runtime.getURL("/icons/peephole-32.png"),
): MountedPeepholeUi {
  const document = target.ownerDocument
  if (findPeepholeInjectionTarget(document, repository) !== target) {
    throw new Error("Peephole requires a visible repository action list.")
  }
  const container = document.createElement("li")
  const host = document.createElement("div")

  container.dataset.peepholeContainer = ""
  container.style.display = "inline-flex"
  container.style.position = "relative"
  container.style.flex = "0 0 auto"
  container.style.alignSelf = "center"
  container.style.listStyle = "none"
  host.id = PEEPHOLE_HOST_ID
  host.style.display = "inline-flex"
  host.style.position = "relative"

  const style = document.createElement("style")
  const appRoot = document.createElement("div")
  style.textContent = stylesheet
  host.append(style, appRoot)

  container.append(host)

  target.append(container)

  const reactRoot = createRoot(appRoot)
  reactRoot.render(
    <PeepholeApp
      logoUrl={logoUrl}
      openSidePanel={openSidePanel}
      repository={repository}
    />,
  )

  return {
    element: container,
    isIntact: () =>
      container.isConnected &&
      host.id === PEEPHOLE_HOST_ID &&
      host.parentElement === container &&
      appRoot.parentElement === host &&
      style.parentElement === host,
    unmount: () => {
      reactRoot.unmount()
      container.remove()
    },
  }
}
