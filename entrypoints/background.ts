import { createRepositoryAnalysisMessageHandler } from "../core/analyzer/messages"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { BuildTargetAnalysisService } from "../core/analyzer/buildTargetAnalysisService"
import { createBuildTargetAnalysisMessageHandler } from "../core/analyzer/targetMessages"
import { GitHubClient } from "../core/github/client"
import { createRepositoryBranchesMessageHandler } from "../core/github/branchMessages"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { RepositoryStructureLoader } from "../core/github/repositoryStructureLoader"
import { TargetKnownFilesLoader } from "../core/github/targetKnownFiles"
import { clearLegacyStoredGitHubToken } from "../core/github/tokenStorage"
import { createSidePanelMessageHandler } from "../core/sidepanel/messages"
import { createGitHubThemeMessageHandler } from "../core/sidepanel/themeMessages"
import { createSidePanelThemeStore } from "../core/sidepanel/themeStorage"

export default defineBackground(() => {
  void clearLegacyStoredGitHubToken()
  const githubClient = new GitHubClient()
  const metadataCache = new RepositoryMetadataCache(githubClient)
  const analysisService = new RepositoryAnalysisService(
    metadataCache.load,
    new KnownRepositoryFilesLoader(githubClient),
    new RepositoryStructureLoader(githubClient),
  )
  const targetAnalysisService = new BuildTargetAnalysisService(
    new TargetKnownFilesLoader(githubClient),
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
      handleTargetAnalysisMessage(message) ??
      handleMessage(message),
  )
})
