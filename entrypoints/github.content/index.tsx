import { createSidePanelMessageClient } from "../../core/sidepanel/messages"
import { GitHubPageController } from "./GitHubPageController"
import { mountPeepholeUi } from "./mountPeepholeUi"

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(context) {
    const sidePanel = createSidePanelMessageClient({
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

    controller.start()
    context.onInvalidated(() => controller.stop())
  },
})
