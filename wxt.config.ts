import { defineConfig } from "wxt"

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Peephole",
    description: "Preview a GitHub repository before you clone it.",
    version: "0.1.0",
    minimum_chrome_version: "116",
    permissions: ["sidePanel"],
    host_permissions: ["https://api.github.com/*"],
  },
})
