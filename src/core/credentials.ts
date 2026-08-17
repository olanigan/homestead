import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Parses simple YAML key-value pairs without adding heavy dependencies
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf(":")
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim()
      let val = trimmed.slice(idx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      result[key] = val
      result[key.toLowerCase()] = val
      result[key.toUpperCase()] = val
    }
  }
  return result
}

/**
 * Resolves API keys across environment variables and ~/.dsh/.credentials.yaml
 */
export function resolveProviderApiKey(provider: "deepseek" | "openrouter" | "modal" | string): string | null {
  const norm = provider.toLowerCase()

  // 1. Direct environment variable lookup
  if (norm === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY.trim()
  }
  if (norm === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY.trim()
  }
  if (process.env[`${norm.toUpperCase()}_API_KEY`]) {
    return process.env[`${norm.toUpperCase()}_API_KEY`]!.trim()
  }

  // 2. Parity with dsh: Check ~/.dsh/.credentials.yaml
  const dshDir = process.env.DSH_HOME || join(homedir(), ".dsh")
  const dshCredsPath = join(dshDir, ".credentials.yaml")
  if (existsSync(dshCredsPath)) {
    try {
      const content = readFileSync(dshCredsPath, "utf8")
      const parsed = parseSimpleYaml(content)
      const dsKey = parsed["deepseek_api_key"] || parsed["DEEPSEEK_API_KEY"]
      if (norm === "deepseek" && dsKey) {
        return dsKey.trim()
      }
      const orKey = parsed["openrouter_api_key"] || parsed["OPENROUTER_API_KEY"]
      if (norm === "openrouter" && orKey) {
        return orKey.trim()
      }
      const genericKey = parsed[`${norm}_api_key`]
      if (genericKey) {
        return genericKey.trim()
      }
    } catch {}
  }

  // 3. Fallback: ~/.homestead/credentials.yaml
  const homesteadCredsPath = join(homedir(), ".homestead", "credentials.yaml")
  if (existsSync(homesteadCredsPath)) {
    try {
      const content = readFileSync(homesteadCredsPath, "utf8")
      const parsed = parseSimpleYaml(content)
      const hsKey = parsed[`${norm}_api_key`] || parsed[`${norm.toUpperCase()}_API_KEY`]
      if (hsKey) {
        return hsKey.trim()
      }
    } catch {}
  }

  return null
}
