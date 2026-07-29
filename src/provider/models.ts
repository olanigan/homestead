import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import type { ModelRecord } from "../types.js"

function isServable(model: ModelRecord): boolean {
  if (model.status === "incomplete") return false
  const tags = (model.metadata?.tags as string[]) || []
  if (tags.includes("vocab")) return false
  if (tags.includes("cloud")) return false
  return true
}

function toOpenAIModel(model: ModelRecord) {
  return {
    id: model.id,
    object: "model",
    created: Math.floor(new Date(model.discoveredAt).getTime() / 1000),
    owned_by: "homestead",
    homestead_metadata: {
      source: model.source,
      format: model.format,
      quantization: model.quantization,
      size_bytes: model.sizeBytes,
      engine: model.engine,
      status: model.status,
      context_length: (model.metadata?.context_length as number) ?? null,
      parameter_count: (model.metadata?.parameter_count as string) ?? null,
    },
  }
}

export function createModelRoutes(registry: Registry): Hono {
  const app = new Hono()

  app.get("/models", (c) => {
    const all = registry.list()
    const servable = all.filter(isServable)
    return c.json({
      object: "list",
      data: servable.map(toOpenAIModel),
    })
  })

  app.get("/models/:id", (c) => {
    const model = registry.get(c.req.param("id"))
    if (!model || !isServable(model)) {
      return c.json({ error: { message: `Model not found: ${c.req.param("id")}`, type: "invalid_request_error", code: "model_not_found" } }, 404)
    }
    return c.json(toOpenAIModel(model))
  })

  return app
}
