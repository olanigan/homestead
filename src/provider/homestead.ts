import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import { createModelRoutes } from "./models.js"
import { createChatRoutes } from "./chat.js"
import { createCompletionsRoutes } from "./completions.js"
import { createHealthRoutes } from "./health.js"

export function createProviderApp(registry: Registry): Hono {
  const app = new Hono()

  app.route("/", createModelRoutes(registry))
  app.route("/", createChatRoutes(registry))
  app.route("/", createCompletionsRoutes(registry))
  app.route("/", createHealthRoutes(registry))

  return app
}
