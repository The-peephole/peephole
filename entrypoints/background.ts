import { createRepositoryAnalysisMessageHandler } from "../core/analyzer/messages"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { GitHubClient } from "../core/github/client"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
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
  )
  const handleMessage = createRepositoryAnalysisMessageHandler(
    analysisService.load,
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
      handleMessage(message),
  )
})
