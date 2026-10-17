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
  // Current GitHub uses repo-header-actions; older pages use pagehead-actions.
  // Neither the selector nor a single matching label alone establishes a group.
  const repositoryKey = getRepositoryKey(repository).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )
  const identity = new RegExp(
    `(?:^|\\s)${repositoryKey}(?:[.,:]?(?:\\s|$))`,
    "i",
  )
  const actionLists = Array.from(
    document.querySelectorAll<HTMLElement>(
      `ul[data-testid="repo-header-actions"], ${REPOSITORY_HEADER_SELECTOR} ul.pagehead-actions`,
    ),
  )
  return (
    actionLists.find((list) => {
      if (
        !isElementVisible(list) ||
        list.closest(".markdown-body, #readme, nav")
      )
        return false
      const kinds = new Set<string>()
      for (const action of list.querySelectorAll<HTMLElement>(
        "button[aria-label], a[aria-label]",
      )) {
        if (action.closest("ul") !== list || !isElementVisible(action)) continue
        const label = action.getAttribute("aria-label") ?? ""
        if (!identity.test(label)) continue
        if (/^watch:/i.test(label)) kinds.add("watch")
        if (/^(?:un)?star /i.test(label)) kinds.add("star")
        if (/^fork /i.test(label)) kinds.add("fork")
      }
      return kinds.size >= 2
    }) ?? null
  )
}

function isElementVisible(element: HTMLElement): boolean {
  let current: HTMLElement | null = element

  while (current) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)

    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" ||
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
