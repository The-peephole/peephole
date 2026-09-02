import type { RepositoryIdentity } from "../../types/repository"
import { getRepositoryKey } from "../../utils/githubUrl"
import {
  findPeepholeInjectionTarget,
  getRepositoryFromGitHubPage,
} from "./githubDom"
import type { MountedPeepholeUi } from "./mountPeepholeUi"

type MountUi = (
  target: HTMLElement,
  repository: RepositoryIdentity,
) => MountedPeepholeUi

type RepositoryChangeListener = (repository: RepositoryIdentity | null) => void

const GITHUB_NAVIGATION_EVENTS = ["turbo:load", "pjax:end", "popstate"]

export class GitHubPageController {
  private currentRepositoryKey: string | null = null
  private currentContextKey: string | null = null
  private hasReportedRepositoryContext = false
  private mountedUi: MountedPeepholeUi | null = null
  private mutationObserver: MutationObserver | null = null
  private scheduledFrame: number | null = null

  constructor(
    private readonly document: Document,
    private readonly location: Location,
    private readonly mountUi: MountUi,
    private readonly onRepositoryChange: RepositoryChangeListener = () =>
      undefined,
  ) {}

  start(): void {
    this.sync()

    for (const eventName of GITHUB_NAVIGATION_EVENTS) {
      window.addEventListener(eventName, this.scheduleSync)
    }

    this.mutationObserver = new MutationObserver(this.scheduleSync)
    this.mutationObserver.observe(this.document.documentElement, {
      childList: true,
      subtree: true,
    })
  }

  stop(): void {
    for (const eventName of GITHUB_NAVIGATION_EVENTS) {
      window.removeEventListener(eventName, this.scheduleSync)
    }

    this.mutationObserver?.disconnect()
    this.mutationObserver = null

    if (this.scheduledFrame !== null) {
      window.cancelAnimationFrame(this.scheduledFrame)
      this.scheduledFrame = null
    }

    this.removeUi()
    this.updateRepositoryContext(null)
  }

  private readonly scheduleSync = (): void => {
    if (this.scheduledFrame !== null) {
      return
    }

    this.scheduledFrame = window.requestAnimationFrame(() => {
      this.scheduledFrame = null
      this.sync()
    })
  }

  private sync(): void {
    const repository = getRepositoryFromGitHubPage(
      this.document,
      this.location.href,
    )

    if (!repository) {
      this.removeUi()
      this.updateRepositoryContext(null)
      return
    }

    const repositoryKey = getRepositoryKey(repository)
    this.updateRepositoryContext(repository)

    if (
      this.currentRepositoryKey === repositoryKey &&
      this.mountedUi?.element.isConnected
    ) {
      return
    }

    this.removeUi()

    const target = findPeepholeInjectionTarget(this.document, repository)

    if (!target) {
      return
    }

    this.mountedUi = this.mountUi(target, repository)
    this.currentRepositoryKey = repositoryKey
  }

  private updateRepositoryContext(repository: RepositoryIdentity | null): void {
    const nextKey = repository ? getRepositoryKey(repository) : null

    if (
      this.hasReportedRepositoryContext &&
      nextKey === this.currentContextKey
    ) {
      return
    }

    this.hasReportedRepositoryContext = true
    this.currentContextKey = nextKey
    this.onRepositoryChange(repository)
  }

  private removeUi(): void {
    this.mountedUi?.unmount()
    this.mountedUi = null
    this.currentRepositoryKey = null
  }
}
