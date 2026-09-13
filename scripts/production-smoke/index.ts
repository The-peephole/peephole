import {
  ProductionSmokeError,
  readApiSmokeConfig,
  runProductionApiSmoke,
  type SmokeReporter,
} from "./api"
import { readHostSmokeConfig, runProductionHostSmoke } from "./host"

const report: SmokeReporter = (check, detail) => {
  console.log(`[PASS] ${check}${detail ? `: ${detail}` : ""}`)
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== "api" && mode !== "host")) {
    throw new ProductionSmokeError(
      "command",
      "Use the api or host mode through the documented npm scripts.",
    )
  }

  if (mode === "api") {
    await runProductionApiSmoke(readApiSmokeConfig(process.env), { report })
  } else {
    await runProductionHostSmoke(readHostSmokeConfig(process.env), { report })
  }

  console.log("PRODUCTION SMOKE PASS")
}

void main().catch((error: unknown) => {
  if (error instanceof ProductionSmokeError) {
    console.error(`[FAIL] ${error.check}: ${error.message}`)
  } else {
    console.error("[FAIL] verifier: Unexpected production smoke error.")
  }
  console.error("PRODUCTION SMOKE FAIL")
  process.exitCode = 1
})
