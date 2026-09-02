import { createRepositoryAnalysisMessageHandler } from "../core/analyzer/messages"
import { RepositoryAnalysisService } from "../core/analyzer/repositoryAnalysisService"
import { GitHubClient } from "../core/github/client"
import { KnownRepositoryFilesLoader } from "../core/github/knownFiles"
import { RepositoryMetadataCache } from "../core/github/repositoryMetadataCache"
import { createSidePanelMessageHandler } from "../core/sidepanel/messages"

export default defineBackground(() => {
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

  browser.runtime.onMessage.addListener(
    (message, sender) =>
      handleSidePanelMessage(message, sender) ?? handleMessage(message),
  )
})
