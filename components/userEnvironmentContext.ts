import { createContext } from "react"

/**
 * M12 (D-035) build-time opt-in (`WXT_USER_ENVIRONMENT_ENABLED`), provided
 * once by the Side Panel root so nested full-stack discovery and controls
 * agree without threading a prop through every analysis view layer.
 * Defaults to off: without a provider, a backend that needs user-provided
 * configuration stays ineligible, exactly as before M12.
 */
export const UserEnvironmentEnabledContext = createContext(false)
