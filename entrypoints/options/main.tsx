import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { OptionsApp } from "./App"
import "./style.css"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Peephole options root was not found.")
}

createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
)
