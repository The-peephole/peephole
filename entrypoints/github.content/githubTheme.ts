import {
  getGitHubThemeSnapshotKey,
  normalizeGitHubThemeSnapshot,
} from "../../core/theme/githubTheme"
import type {
  GitHubThemeSnapshot,
  GitHubThemeTokenKey,
} from "../../types/theme"

export const GITHUB_PRIMER_THEME_TOKENS: Record<
  GitHubThemeTokenKey,
  `--${string}`
> = {
  background: "--bgColor-default",
  backgroundSubtle: "--bgColor-muted",
  backgroundInset: "--bgColor-inset",
  foreground: "--fgColor-default",
  foregroundMuted: "--fgColor-muted",
  border: "--borderColor-default",
  borderMuted: "--borderColor-muted",
  accent: "--fgColor-accent",
  success: "--fgColor-success",
  attention: "--fgColor-attention",
  danger: "--fgColor-danger",
  focus: "--focus-outlineColor",
  buttonForeground: "--button-default-fgColor-rest",
  buttonBackground: "--button-default-bgColor-rest",
  buttonHoverBackground: "--button-default-bgColor-hover",
  buttonBorder: "--button-default-borderColor-rest",
  buttonHoverBorder: "--button-default-borderColor-hover",
  primaryButtonForeground: "--button-primary-fgColor-rest",
  primaryButtonBackground: "--button-primary-bgColor-rest",
  primaryButtonHoverBackground: "--button-primary-bgColor-hover",
  primaryButtonBorder: "--button-primary-borderColor-rest",
}

const THEME_ATTRIBUTE_FILTER = [
  "data-color-mode",
  "data-light-theme",
  "data-dark-theme",
]

type ThemeChangeListener = (theme: GitHubThemeSnapshot | null) => void

interface FrameScheduler {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

export function readGitHubTheme(
  document: Document,
): GitHubThemeSnapshot | null {
  const view = document.defaultView
  if (!view) return null

  const computed = view.getComputedStyle(document.documentElement)
  const tokens = Object.fromEntries(
    Object.entries(GITHUB_PRIMER_THEME_TOKENS).map(([key, token]) => [
      key,
      computed.getPropertyValue(token).trim(),
    ]),
  )
  const colorScheme = computed.colorScheme.trim()
  const supportsColor = view.CSS?.supports
    ? (value: string) => view.CSS.supports("color", value)
    : undefined

  return normalizeGitHubThemeSnapshot({ colorScheme, tokens }, supportsColor)
}

export class GitHubThemeObserver {
  private currentThemeKey: string | null = null
  private hasReportedTheme = false
  private mediaQuery: MediaQueryList | null = null
  private mutationObserver: MutationObserver | null = null
  private scheduledFrame: number | null = null

  constructor(
    private readonly document: Document,
    private readonly onThemeChange: ThemeChangeListener,
    private readonly readTheme: (
      document: Document,
    ) => GitHubThemeSnapshot | null = readGitHubTheme,
    private readonly scheduler: FrameScheduler = createFrameScheduler(document),
  ) {}

  start(): void {
    this.sync()

    const view = this.document.defaultView
    if (!view) return

    this.mutationObserver = new view.MutationObserver(this.scheduleSync)
    this.mutationObserver.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTE_FILTER,
    })

    this.mediaQuery = view.matchMedia?.("(prefers-color-scheme: dark)") ?? null
    this.mediaQuery?.addEventListener("change", this.scheduleSync)
  }

  stop(): void {
    this.mutationObserver?.disconnect()
    this.mutationObserver = null
    this.mediaQuery?.removeEventListener("change", this.scheduleSync)
    this.mediaQuery = null

    if (this.scheduledFrame !== null) {
      this.scheduler.cancel(this.scheduledFrame)
      this.scheduledFrame = null
    }
  }

  private readonly scheduleSync = (): void => {
    if (this.scheduledFrame !== null) return

    this.scheduledFrame = this.scheduler.request(() => {
      this.scheduledFrame = null
      this.sync()
    })
  }

  private sync(): void {
    const theme = this.readTheme(this.document)
    const nextKey = getGitHubThemeSnapshotKey(theme)

    if (this.hasReportedTheme && nextKey === this.currentThemeKey) return

    this.hasReportedTheme = true
    this.currentThemeKey = nextKey
    this.onThemeChange(theme)
  }
}

function createFrameScheduler(document: Document): FrameScheduler {
  const view = document.defaultView
  if (!view) {
    throw new Error("GitHub theme observation requires a browser window.")
  }

  return {
    request: (callback) =>
      typeof view.requestAnimationFrame === "function"
        ? view.requestAnimationFrame(callback)
        : view.setTimeout(() => callback(performance.now()), 0),
    cancel: (handle) => {
      if (typeof view.cancelAnimationFrame === "function") {
        view.cancelAnimationFrame(handle)
      } else {
        view.clearTimeout(handle)
      }
    },
  }
}
