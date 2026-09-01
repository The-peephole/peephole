import type { RepositoryIdentity } from "../types/repository"

const RESERVED_GITHUB_ROOTS = new Set([
  "about",
  "account",
  "apps",
  "business",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "git-guides",
  "github",
  "issues",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
  "users",
])

const OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY_PATTERN = /^[a-z\d_.-]+$/i

export function parseGitHubRepositoryUrl(
  urlValue: string,
): RepositoryIdentity | null {
  let url: URL

  try {
    url = new URL(urlValue)
  } catch {
    return null
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    return null
  }

  const [owner, repo] = url.pathname.split("/").filter(Boolean)

  if (
    !owner ||
    !repo ||
    RESERVED_GITHUB_ROOTS.has(owner.toLowerCase()) ||
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repo)
  ) {
    return null
  }

  return { owner, repo }
}

export function getRepositoryKey(repository: RepositoryIdentity): string {
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`
}
