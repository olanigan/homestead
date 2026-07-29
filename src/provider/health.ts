import { Hono } from "hono"
import type { Registry } from "../core/registry.js"

export function createHealthRoutes(registry: Registry): Hono {
  const app = new Hono()
  const startTime = Date.now()

  app.get("/health", (c) => {
    const stats = registry.stats()
    return c.json({
      status: "ok",
      version: "0.0.2",
      models_available: stats.totalModels,
      models_serving: stats.servingCount,
      uptime_sec: Math.floor((Date.now() - startTime) / 1000),
    })
  })

  return app
}
