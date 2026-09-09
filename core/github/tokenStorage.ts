/** Removes the credential stored by Peephole versions that used personal
 * access tokens. The migration is intentionally one-way: current builds do
 * not expose any API that can read or write a GitHub credential. */

const LEGACY_STORAGE_KEY = "peepholeGithubToken"

export async function clearLegacyStoredGitHubToken(): Promise<void> {
  await browser.storage.local.remove(LEGACY_STORAGE_KEY)
}
