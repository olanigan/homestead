import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import { createModelRoutes } from "./models.js"
import { createChatRoutes } from "./chat.js"
import { createCompletionsRoutes } from "./completions.js"
import { createHealthRoutes } from "./health.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version: VERSION } = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
) as { version: string }

export function createProviderApp(registry: Registry): Hono {
  const app = new Hono()

  app.route("/", createModelRoutes(registry))
  app.route("/", createChatRoutes(registry))
  app.route("/", createCompletionsRoutes(registry))
  app.route("/", createHealthRoutes(registry, VERSION))

  return app
}
