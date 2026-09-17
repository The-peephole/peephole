import { describe, expect, it } from "vitest"

import { detectEnvironmentRequirements } from "../core/analyzer/environmentRequirements"

function classify(
  sourceRoot: string,
  content: string,
  templatePath = ".env.example",
) {
  return detectEnvironmentRequirements(sourceRoot, [templatePath], {
    [templatePath]: content,
  })
}

function find(
  requirements: ReturnType<typeof classify>,
  name: string,
): ReturnType<typeof classify>[number] | undefined {
  return requirements.find((requirement) => requirement.name === name)
}

describe("detectEnvironmentRequirements", () => {
  it.each([
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.local.example",
  ])("parses variable names from %s", (templatePath) => {
    const requirements = classify(".", "FOO=bar\n", templatePath)

    expect(requirements.map((requirement) => requirement.name)).toEqual(["FOO"])
    expect(requirements[0]?.sourceTemplate).toBe(templatePath)
  })

  it("never reads a real .env file", () => {
    const requirements = detectEnvironmentRequirements(
      ".",
      [".env", ".env.local"],
      { ".env": "SECRET=abc123", ".env.local": "SECRET=abc123" },
    )

    expect(requirements).toEqual([])
  })

  it("supports the export VAR= syntax", () => {
    const requirements = classify(".", "export FOO=bar\n")

    expect(requirements.map((requirement) => requirement.name)).toEqual(["FOO"])
  })

  it("ignores comments and blank lines", () => {
    const requirements = classify(".", "# comment\n\nFOO=bar\n")

    expect(requirements.map((requirement) => requirement.name)).toEqual(["FOO"])
  })

  it("deduplicates a variable declared more than once", () => {
    const requirements = classify(".", "FOO=bar\nFOO=baz\n")

    expect(requirements).toHaveLength(1)
  })

  it("orders requirements deterministically by name", () => {
    const requirements = classify(".", "ZETA=1\nALPHA=1\n")

    expect(requirements.map((requirement) => requirement.name)).toEqual([
      "ALPHA",
      "ZETA",
    ])
  })

  it("classifies PORT, HOST, and NODE_ENV as auto-configurable", () => {
    const requirements = classify(
      ".",
      "PORT=3000\nHOST=0.0.0.0\nNODE_ENV=production\n",
    )

    for (const name of ["PORT", "HOST", "NODE_ENV"]) {
      expect(find(requirements, name)?.requirementKind).toBe(
        "auto-configurable",
      )
      expect(find(requirements, name)?.sensitivity).toBe("public")
    }
  })

  it.each(["JWT_SECRET", "SESSION_SECRET", "COOKIE_SECRET", "CSRF_SECRET"])(
    "classifies %s as a preview-generated secret candidate",
    (name) => {
      const requirements = classify(".", `${name}=\n`)

      expect(find(requirements, name)?.requirementKind).toBe(
        "preview-generated-candidate",
      )
      expect(find(requirements, name)?.sensitivity).toBe("secret-like")
    },
  )

  it.each(["API_KEY", "TOKEN", "PAT", "CLIENT_SECRET", "PRIVATE_KEY"])(
    "classifies %s as user-required and secret-like",
    (name) => {
      const requirements = classify(".", `${name}=\n`)

      expect(find(requirements, name)?.requirementKind).toBe("user-required")
      expect(find(requirements, name)?.sensitivity).toBe("secret-like")
    },
  )

  it("keeps MARKETPLACE_PAT classified as a user-required secret-like requirement", () => {
    const requirements = classify(".", "MARKETPLACE_PAT=\n")

    expect(find(requirements, "MARKETPLACE_PAT")).toMatchObject({
      requirementKind: "user-required",
      sensitivity: "secret-like",
    })
  })

  it.each([
    "DATABASE_URL",
    "POSTGRES_URL",
    "MYSQL_URL",
    "REDIS_URL",
    "MONGODB_URI",
  ])(
    "classifies %s as a database requirement, not an auto-provisioned database",
    (name) => {
      const requirements = classify(".", `${name}=\n`)

      expect(find(requirements, name)?.requirementKind).toBe(
        "database-requirement",
      )
      expect(find(requirements, name)?.sensitivity).toBe("secret-like")
    },
  )

  it.each(["VITE_API_URL", "NEXT_PUBLIC_API_URL"])(
    "classifies %s as a client-public external/routing requirement",
    (name) => {
      const requirements = classify(".", `${name}=\n`)

      expect(find(requirements, name)).toMatchObject({
        exposure: "client-public",
        requirementKind: "external-routing-candidate",
      })
    },
  )

  it.each(["VITE_API_TOKEN", "NEXT_PUBLIC_SECRET"])(
    "warns when %s combines a client-public prefix with a secret-like name",
    (name) => {
      const requirements = classify(".", `${name}=\n`)
      const requirement = find(requirements, name)

      expect(requirement?.exposure).toBe("client-public")
      expect(requirement?.sensitivity).toBe("secret-like")
      expect(requirement?.warnings.join(" ")).toContain(
        "Secret-like variable name is exposed through a client-public prefix.",
      )
    },
  )

  it("never treats a public prefix as a safe override for a secret-like name", () => {
    const requirements = classify(".", "VITE_PRIVATE_KEY=\n")

    expect(find(requirements, "VITE_PRIVATE_KEY")).toMatchObject({
      exposure: "client-public",
      sensitivity: "secret-like",
      requirementKind: "user-required",
    })
  })

  it("leaves an unrecognized variable as unknown rather than asserting false certainty", () => {
    const requirements = classify(".", "SOME_UNUSUAL_NAME=\n")

    expect(find(requirements, "SOME_UNUSUAL_NAME")).toMatchObject({
      requirementKind: "unknown",
      sensitivity: "unknown",
    })
  })

  it("treats an ordinary client-public variable with no other signal as public", () => {
    const requirements = classify(".", "VITE_APP_TITLE=\n")

    expect(find(requirements, "VITE_APP_TITLE")).toMatchObject({
      exposure: "client-public",
      sensitivity: "public",
      requirementKind: "unknown",
    })
  })

  it("never includes the raw template value anywhere in the result", () => {
    const requirements = classify(".", "API_KEY=super-secret-value-123\n")

    expect(JSON.stringify(requirements)).not.toContain("super-secret-value-123")
  })

  it("tags every requirement with the given source root", () => {
    const requirements = classify("backend", "PORT=3000\n")

    expect(requirements[0]?.sourceRoot).toBe("backend")
  })

  it("keeps two different source roots from merging into one result", () => {
    const frontend = classify("frontend", "VITE_API_URL=\n")
    const backend = classify("backend", "PORT=3000\n")

    expect(frontend.map((requirement) => requirement.sourceRoot)).toEqual([
      "frontend",
    ])
    expect(backend.map((requirement) => requirement.sourceRoot)).toEqual([
      "backend",
    ])
  })

  it("returns nothing when no template file is present", () => {
    const requirements = detectEnvironmentRequirements(".", [], {})

    expect(requirements).toEqual([])
  })
})
