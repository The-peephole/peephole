import { createSidePanelMessageClient } from "../../core/sidepanel/messages"
import { createGitHubThemeMessageClient } from "../../core/sidepanel/themeMessages"
import { GitHubPageController } from "./GitHubPageController"
import { GitHubThemeObserver } from "./githubTheme"
import { mountPeepholeUi } from "./mountPeepholeUi"
import { getRepositoryFromGitHubPage } from "./githubDom"
import { subscribeToRepositoryReturn } from "../../core/sidepanel/contentLifecycle"

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(context) {
    const sidePanel = createSidePanelMessageClient({
      send: (message) => browser.runtime.sendMessage(message),
    })
    const theme = createGitHubThemeMessageClient({
      send: (message) => browser.runtime.sendMessage(message),
    })
    const controller = new GitHubPageController(
      document,
      window.location,
      (target, repository) =>
        mountPeepholeUi(target, repository, sidePanel.open),
      (repository) => {
        void sidePanel.sync(repository).catch(() => undefined)
      },
    )
    const themeObserver = new GitHubThemeObserver(document, (snapshot) => {
      void theme.sync(snapshot).catch(() => undefined)
    })

    controller.start()
    themeObserver.start()
    const unsubscribeReturn = subscribeToRepositoryReturn(window, () => {
      void sidePanel
        .sync(getRepositoryFromGitHubPage(document, window.location.href))
        .catch(() => undefined)
    })
    context.onInvalidated(() => {
      unsubscribeReturn()
      themeObserver.stop()
      controller.stop()
    })
  },
})
