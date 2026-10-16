import { Hono } from "hono"
import type { Registry } from "../core/registry.js"

export function createHealthRoutes(registry: Registry, version: string): Hono {
  const app = new Hono()
  const startTime = Date.now()

  const healthHandler = (c: any) => {
    const stats = registry.stats()
    return c.json({
      status: "ok",
      version,
      models_available: stats.totalModels,
      models_serving: stats.servingCount,
      uptime_sec: Math.floor((Date.now() - startTime) / 1000),
    })
  }

  app.get("/health", healthHandler)
  app.get("/v1/health", healthHandler)

  return app
}
