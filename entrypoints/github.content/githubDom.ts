import type { RepositoryIdentity } from "../../types/repository"
import {
  getRepositoryKey,
  parseGitHubRepositoryUrl,
} from "../../utils/githubUrl"

const REPOSITORY_META_SELECTOR =
  'meta[name="octolytics-dimension-repository_nwo"]'
const REPOSITORY_HEADER_SELECTOR = "#repository-container-header"

export function getRepositoryFromGitHubPage(
  document: Document,
  url: string,
): RepositoryIdentity | null {
  const repository = parseGitHubRepositoryUrl(url)

  if (!repository) {
    return null
  }

  const expectedKey = getRepositoryKey(repository)
  const metadataRepository = document
    .querySelector<HTMLMetaElement>(REPOSITORY_META_SELECTOR)
    ?.content.trim()
    .toLowerCase()

  if (metadataRepository === expectedKey) {
    return repository
  }

  const header = document.querySelector(REPOSITORY_HEADER_SELECTOR)
  const expectedPath = `/${repository.owner}/${repository.repo}`.toLowerCase()
  const repositoryLink = Array.from(
    header?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [],
  ).some((link) => link.pathname.toLowerCase() === expectedPath)

  return repositoryLink ? repository : null
}

export function findPeepholeInjectionTarget(
  document: Document,
  repository: RepositoryIdentity,
): HTMLElement | null {
  const repositoryKey = getRepositoryKey(repository)
  const repositoryAction = Array.from(
    document.querySelectorAll<HTMLElement>("button[aria-label], a[aria-label]"),
  ).find((element) => {
    const label = element.getAttribute("aria-label")?.toLowerCase() ?? ""

    return (
      label.includes(repositoryKey) &&
      (label.startsWith("watch:") ||
        label.startsWith("star ") ||
        label.startsWith("fork ")) &&
      isElementVisible(element)
    )
  })
  const currentActionList = repositoryAction?.closest<HTMLElement>("ul")

  if (currentActionList && isElementVisible(currentActionList)) {
    return currentActionList
  }

  const legacyActionList = Array.from(
    document.querySelectorAll<HTMLElement>(
      `${REPOSITORY_HEADER_SELECTOR} ul.pagehead-actions`,
    ),
  ).find(isElementVisible)

  if (legacyActionList) {
    return legacyActionList
  }

  const visibleHeader = Array.from(
    document.querySelectorAll<HTMLElement>(REPOSITORY_HEADER_SELECTOR),
  ).find(isElementVisible)

  return visibleHeader ?? document.body
}

function isElementVisible(element: HTMLElement): boolean {
  let current: HTMLElement | null = element

  while (current) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)

    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      return false
    }

    current = current.parentElement
  }

  return true
}
