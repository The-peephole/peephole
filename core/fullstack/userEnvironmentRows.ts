import { classifyUserEnvironmentRequirement } from "../userEnvironment/userEnvironmentPolicy"
import type { EnvironmentRequirement } from "../../types/environment"
import type { UserEnvironmentNameDisposition } from "../../types/userEnvironment"

export interface UserEnvironmentRow {
  name: string
  disposition: UserEnvironmentNameDisposition
  /** Who provides the value. */
  source: "Peephole" | "You" | "Unsupported"
  /** Short, value-free explanation shown next to the name. */
  description: string
  acceptsInput: boolean
}

const DESCRIPTIONS: Record<
  UserEnvironmentNameDisposition,
  { source: UserEnvironmentRow["source"]; description: string }
> = {
  "platform-managed": { source: "Peephole", description: "Auto-configured" },
  "generated-secret": {
    source: "Peephole",
    description: "Generated automatically",
  },
  "temporary-database": {
    source: "Peephole",
    description: "Temporary database",
  },
  "user-configurable": { source: "You", description: "Input required" },
  "secret-like-unsupported": {
    source: "Unsupported",
    description: "Secrets and external credentials are not supported yet",
  },
  "external-routing-unsupported": {
    source: "Unsupported",
    description: "External endpoints are unsupported (no outbound network)",
  },
  "client-public-unsupported": {
    source: "Unsupported",
    description: "Frontend build variables are not supported",
  },
  "reserved-unsupported": {
    source: "Unsupported",
    description: "Reserved for the runtime",
  },
  "invalid-name-unsupported": {
    source: "Unsupported",
    description: "Name format is not supported",
  },
}

/** UX-only view of one backend's declared requirements. The server
 * re-derives the authoritative names at the exact commit. */
export function describeUserEnvironmentRows(
  requirements: readonly EnvironmentRequirement[],
): UserEnvironmentRow[] {
  const seen = new Set<string>()
  const rows: UserEnvironmentRow[] = []
  for (const requirement of requirements) {
    if (seen.has(requirement.name)) continue
    seen.add(requirement.name)
    const disposition = classifyUserEnvironmentRequirement(requirement)
    rows.push({
      name: requirement.name,
      disposition,
      ...DESCRIPTIONS[disposition],
      acceptsInput: disposition === "user-configurable",
    })
  }
  return rows.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
}
