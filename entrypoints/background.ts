import { createRepositoryAnalysisMessageHandler } from "../core/analyzer/messages"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import { createBuildTargetAnalysisMessageHandler } from "../core/analyzer/targetMessages"
import { GitHubClient } from "../core/github/client"
import { createGitHubGatewayFetcher } from "../core/github/gatewayFetcher"
import { BackendCandidateLoader } from "../core/github/backendCandidateLoader"
import { createRepositoryBranchesMessageHandler } from "../core/github/branchMessages"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryLiveDeploymentCache } from "../core/github/liveDeploymentCache"
import { createLiveDeploymentMessageHandler } from "../core/github/liveDeploymentMessages"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { RepositoryDeploymentsLoader } from "../core/github/repositoryDeploymentsLoader"
import { RepositoryStructureLoader } from "../core/github/repositoryStructureLoader"
import { TargetKnownFilesLoader } from "../core/github/targetKnownFiles"
import { clearLegacyStoredGitHubToken } from "../core/github/tokenStorage"
import { parsePreviewApiBaseUrl } from "../core/preview/config"
import {
  clearStoredPreviewSession,
  getStoredPreviewSession,
} from "../core/preview/sessionStorage"
import { createSidePanelMessageHandler } from "../core/sidepanel/messages"
import { createGitHubThemeMessageHandler } from "../core/sidepanel/themeMessages"
import { createSidePanelThemeStore } from "../core/sidepanel/themeStorage"

export default defineBackground(() => {
  void clearLegacyStoredGitHubToken()
  const githubClient = new GitHubClient({
    requestCache: {},
    fetcher: createGitHubFetcher(),
  })
  const metadataCache = new RepositoryMetadataCache(githubClient)
  const analysisService = new RepositoryAnalysisService(
    metadataCache.load,
    new KnownRepositoryFilesLoader(githubClient),
    new RepositoryStructureLoader(githubClient),
    new BackendCandidateLoader(githubClient),
  )
  const targetAnalysisService = new BuildTargetAnalysisService(
    new TargetKnownFilesLoader(githubClient),
  )
  const liveDeploymentCache = new RepositoryLiveDeploymentCache(
    new RepositoryDeploymentsLoader(githubClient),
  )
  const handleMessage = createRepositoryAnalysisMessageHandler(
    analysisService.load,
  )
  const handleTargetAnalysisMessage = createBuildTargetAnalysisMessageHandler(
    targetAnalysisService.load,
  )
  const handleRepositoryBranchesMessage =
    createRepositoryBranchesMessageHandler((repository, options = {}) =>
      githubClient.listRepositoryBranches(repository, options.signal),
    )
  const handleLiveDeploymentMessage = createLiveDeploymentMessageHandler(
    liveDeploymentCache.load,
  )
  const handleSidePanelMessage = createSidePanelMessageHandler(
    browser.sidePanel,
  )
  const handleGitHubThemeMessage = createGitHubThemeMessageHandler(
    createSidePanelThemeStore(),
    { send: (message) => browser.runtime.sendMessage(message) },
  )

  browser.runtime.onMessage.addListener(
    (message, sender) =>
      handleGitHubThemeMessage(message, sender) ??
      handleSidePanelMessage(message, sender) ??
      handleRepositoryBranchesMessage(message) ??
      handleLiveDeploymentMessage(message) ??
      handleTargetAnalysisMessage(message) ??
      handleMessage(message),
  )
})

/**
 * Signed-in users read public GitHub data through the Preview API gateway
 * (server-owned credential, shared cache); everyone else keeps the direct
 * unauthenticated path. Off unless WXT_GITHUB_GATEWAY_ENABLED is "true".
 */
function createGitHubFetcher(): typeof fetch | undefined {
  if (import.meta.env.WXT_GITHUB_GATEWAY_ENABLED !== "true") return undefined
  let previewApiBaseUrl: string | null
  try {
    previewApiBaseUrl = parsePreviewApiBaseUrl(
      import.meta.env.WXT_PREVIEW_API_BASE_URL,
    )
  } catch {
    return undefined
  }
  return previewApiBaseUrl
    ? createGitHubGatewayFetcher({
        previewApiBaseUrl,
        getSession: getStoredPreviewSession,
        clearSession: clearStoredPreviewSession,
      })
    : undefined
}
