export const GITHUB_THEME_TOKEN_KEYS = [
  "background",
  "backgroundSubtle",
  "backgroundInset",
  "foreground",
  "foregroundMuted",
  "border",
  "borderMuted",
  "accent",
  "success",
  "attention",
  "danger",
  "focus",
  "buttonForeground",
  "buttonBackground",
  "buttonHoverBackground",
  "buttonBorder",
  "buttonHoverBorder",
  "primaryButtonForeground",
  "primaryButtonBackground",
  "primaryButtonHoverBackground",
  "primaryButtonBorder",
] as const

export type GitHubThemeTokenKey = (typeof GITHUB_THEME_TOKEN_KEYS)[number]

export type GitHubThemeTokens = Record<GitHubThemeTokenKey, string>

export interface GitHubThemeSnapshot {
  colorScheme: "light" | "dark"
  tokens: GitHubThemeTokens
}
