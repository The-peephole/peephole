import { defineConfig } from "wxt"

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Peephole",
    description: "Preview a GitHub repository before you clone it.",
    version: "0.1.0",
    permissions: [],
    host_permissions: ["https://api.github.com/*"],
  },
})
