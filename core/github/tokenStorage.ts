/**
 * Extension-only. Stores the optional GitHub personal access token in this
 * browser profile's local extension storage -- never synced, never bundled
 * into the built extension, and only ever sent to https://api.github.com.
 * Unauthenticated GitHub API requests are limited to 60/hour per IP; a
 * token (no scopes required for public repositories) raises that to
 * 5,000/hour.
 */

const STORAGE_KEY = "peepholeGithubToken"

export async function getStoredGitHubToken(): Promise<string | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY]
  return typeof value === "string" && value.trim() ? value : null
}

export async function setStoredGitHubToken(token: string): Promise<void> {
  const trimmed = token.trim()

  if (!trimmed) {
    throw new Error("GitHub token must not be empty.")
  }

  await browser.storage.local.set({ [STORAGE_KEY]: trimmed })
}

export async function clearStoredGitHubToken(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY)
}
