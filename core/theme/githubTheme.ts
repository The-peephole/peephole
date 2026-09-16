import {
  GITHUB_THEME_TOKEN_KEYS,
  type GitHubThemeSnapshot,
  type GitHubThemeTokenKey,
  type GitHubThemeTokens,
} from "../../types/theme"

export const PEEPHOLE_THEME_CSS_VARIABLES: Record<
  GitHubThemeTokenKey,
  `--peephole-${string}`
> = {
  background: "--peephole-bg",
  backgroundSubtle: "--peephole-bg-subtle",
  backgroundInset: "--peephole-bg-inset",
  foreground: "--peephole-fg",
  foregroundMuted: "--peephole-fg-muted",
  border: "--peephole-border",
  borderMuted: "--peephole-border-muted",
  accent: "--peephole-accent",
  success: "--peephole-success",
  attention: "--peephole-attention",
  danger: "--peephole-danger",
  focus: "--peephole-focus",
  buttonForeground: "--peephole-button-fg",
  buttonBackground: "--peephole-button-bg",
  buttonHoverBackground: "--peephole-button-bg-hover",
  buttonBorder: "--peephole-button-border",
  buttonHoverBorder: "--peephole-button-border-hover",
  primaryButtonForeground: "--peephole-primary-fg",
  primaryButtonBackground: "--peephole-primary-bg",
  primaryButtonHoverBackground: "--peephole-primary-bg-hover",
  primaryButtonBorder: "--peephole-primary-border",
}

type SupportsColor = (value: string) => boolean

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
const FUNCTION_COLOR =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^;{}()]*\)$/i

export function normalizeGitHubThemeSnapshot(
  value: unknown,
  supportsColor?: SupportsColor,
): GitHubThemeSnapshot | null {
  if (!isObject(value) || !isObject(value.tokens)) {
    return null
  }

  if (value.colorScheme !== "light" && value.colorScheme !== "dark") {
    return null
  }

  const tokens = {} as GitHubThemeTokens

  for (const key of GITHUB_THEME_TOKEN_KEYS) {
    const token = normalizeColor(value.tokens[key], supportsColor)
    if (!token) {
      return null
    }
    tokens[key] = token
  }

  return { colorScheme: value.colorScheme, tokens }
}

export function getGitHubThemeSnapshotKey(
  theme: GitHubThemeSnapshot | null,
): string {
  if (!theme) return "fallback"
  return `${theme.colorScheme}:${GITHUB_THEME_TOKEN_KEYS.map(
    (key) => theme.tokens[key],
  ).join("|")}`
}

function normalizeColor(
  value: unknown,
  supportsColor?: SupportsColor,
): string | null {
  if (typeof value !== "string") return null

  const candidate = value.trim()
  if (
    candidate.length === 0 ||
    candidate.length > 128 ||
    (!HEX_COLOR.test(candidate) && !FUNCTION_COLOR.test(candidate)) ||
    (supportsColor && !supportsColor(candidate))
  ) {
    return null
  }

  return candidate
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
