import { GITHUB_THEME_TOKEN_KEYS } from "../types/theme"
import type { GitHubThemeSnapshot, GitHubThemeTokens } from "../types/theme"

export function createThemeFixture(
  colorScheme: GitHubThemeSnapshot["colorScheme"],
  seed = colorScheme === "light" ? 0x101010 : 0x202020,
): GitHubThemeSnapshot {
  const tokens = Object.fromEntries(
    GITHUB_THEME_TOKEN_KEYS.map((key, index) => [
      key,
      `#${(seed + index).toString(16).padStart(6, "0")}`,
    ]),
  ) as GitHubThemeTokens

  return { colorScheme, tokens }
}
