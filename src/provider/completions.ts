import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import { engineManager } from "../engines/index.js"
import { proxyToEngine } from "./proxy.js"
import { errorResponse } from "./errors.js"

export function createCompletionsRoutes(registry: Registry): Hono {
  const app = new Hono()

  app.post("/completions", async (c) => {
    const body = await c.req.json() as { model?: string; prompt?: string; stream?: boolean }
    const reqModelName = body.model

    if (!reqModelName) {
      return errorResponse(c, 400, "model field is required", "invalid_request_error", "model_not_found")
    }

    const model = registry.get(reqModelName)
    if (!model) {
      return errorResponse(c, 400, `Model not found: ${reqModelName}`, "invalid_request_error", "model_not_found")
    }

    const engineBody = { ...body, model: model.name }

    const tags = (model.metadata?.tags as string[]) || []
    if (tags.includes("vocab")) {
      return errorResponse(c, 400, "vocabulary-only file cannot be served", "invalid_request_error", "model_not_servable")
    }
    if (tags.includes("cloud")) {
      return errorResponse(c, 400, "cloud-only model not available locally", "invalid_request_error", "model_not_servable")
    }
    if (tags.includes("incomplete")) {
      return errorResponse(c, 400, "download is incomplete", "invalid_request_error", "model_not_servable")
    }

    if (model.status !== "serving") {
      const engine = engineManager.selectEngine(model)
      if (!engine) {
        return errorResponse(c, 503, `No compatible engine for format: ${model.format}`, "server_error", "engine_unavailable")
      }
      try {
        const proc = await engine.serve(model, 8080)
        registry.updateStatus(model.id, "serving")
        return proxyToEngine(proc.endpoint, "/completions", engineBody)
      } catch (err) {
        return errorResponse(c, 503, `Failed to serve model: ${err}`, "server_error", "serve_failed")
      }
    }

    const processes = engineManager.getRunningProcesses()
    const proc = processes.find((p) => p.modelId === model.id)
    if (!proc) {
      registry.updateStatus(model.id, "stopped")
      try {
        const engine = engineManager.selectEngine(model)
        if (!engine) {
          return errorResponse(c, 503, `No compatible engine for format: ${model.format}`, "server_error", "engine_unavailable")
        }
        const newProc = await engine.serve(model, 8080)
        registry.updateStatus(model.id, "serving")
        return proxyToEngine(newProc.endpoint, "/completions", engineBody)
      } catch (err) {
        return errorResponse(c, 503, `Failed to serve model: ${err}`, "server_error", "serve_failed")
      }
    }

    return proxyToEngine(proc.endpoint, "/completions", engineBody)
  })

  return app
}
