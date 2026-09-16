import {
  PEEPHOLE_THEME_CSS_VARIABLES,
  normalizeGitHubThemeSnapshot,
} from "../../core/theme/githubTheme"
import type { GitHubThemeSnapshot } from "../../types/theme"

interface SidePanelThemeClient {
  load(tabId: number): Promise<GitHubThemeSnapshot | null>
  subscribe(
    tabId: number,
    onThemeChange: (theme: GitHubThemeSnapshot | null) => void,
  ): () => void
}

export class SidePanelThemeController {
  private active = false
  private updateVersion = 0
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly tabId: number,
    private readonly client: SidePanelThemeClient,
  ) {}

  start(): void {
    if (this.active) return
    this.active = true

    this.unsubscribe = this.client.subscribe(this.tabId, (theme) => {
      this.updateVersion += 1
      this.apply(theme)
    })

    const loadVersion = this.updateVersion
    void this.loadInitialTheme(loadVersion)
  }

  stop(): void {
    this.active = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async loadInitialTheme(loadVersion: number): Promise<void> {
    let theme: GitHubThemeSnapshot | null = null

    try {
      theme = await this.client.load(this.tabId)
    } catch {
      // Keep the local CSS fallback when session storage is unavailable.
    }

    if (this.active && this.updateVersion === loadVersion) {
      this.apply(theme)
    }
  }

  private apply(theme: GitHubThemeSnapshot | null): void {
    const supportsColor = this.root.ownerDocument.defaultView?.CSS?.supports
      ? (value: string) =>
          this.root.ownerDocument.defaultView?.CSS.supports("color", value) ??
          false
      : undefined
    const normalized = theme
      ? normalizeGitHubThemeSnapshot(theme, supportsColor)
      : null

    if (!normalized) {
      delete this.root.dataset.peepholeTheme
      this.root.style.removeProperty("color-scheme")
      for (const cssVariable of Object.values(PEEPHOLE_THEME_CSS_VARIABLES)) {
        this.root.style.removeProperty(cssVariable)
      }
      return
    }

    this.root.dataset.peepholeTheme = normalized.colorScheme
    this.root.style.colorScheme = normalized.colorScheme
    for (const [key, cssVariable] of Object.entries(
      PEEPHOLE_THEME_CSS_VARIABLES,
    )) {
      this.root.style.setProperty(
        cssVariable,
        normalized.tokens[key as keyof typeof normalized.tokens],
      )
    }
  }
}
