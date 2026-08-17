import { Hono } from "hono"
import type { Registry } from "../core/registry.js"
import { ensureServingProcess } from "./serve-model.js"
import { proxyToEngine } from "./proxy.js"
import { errorResponse } from "./errors.js"
import { resolveProviderApiKey } from "../core/credentials.js"

export function createChatRoutes(registry: Registry): Hono {
  const app = new Hono()

  app.post("/chat/completions", async (c) => {
    const body = await c.req.json() as { model?: string; messages?: unknown[]; stream?: boolean }
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
    const isRemote =
      model.engine === "modal" ||
      model.engine === "remote" ||
      model.source === "modal" ||
      model.source === "deepseek" ||
      model.source === "openrouter" ||
      model.source === "remote" ||
      typeof model.metadata?.modalEndpoint === "string" ||
      typeof model.metadata?.remoteEndpoint === "string"

    if (tags.includes("cloud") && !isRemote) {
      return errorResponse(c, 400, "cloud-only model not available locally", "invalid_request_error", "model_not_servable")
    }
    if (tags.includes("incomplete")) {
      return errorResponse(c, 400, "download is incomplete", "invalid_request_error", "model_not_servable")
    }

    const result = await ensureServingProcess(model, registry)
    if (result.error) {
      return errorResponse(c, result.error.status, result.error.message, result.error.type, result.error.code)
    }

    // Resolve custom / authorization headers
    const customHeaders: Record<string, string> = {}
    const incomingAuth = c.req.header("Authorization")
    const provider = (model.metadata?.provider as string) || model.source
    const resolvedKey = (model.metadata?.apiKey as string) || (model.metadata?.api_key as string) || resolveProviderApiKey(provider)

    let effectiveAuth: string | undefined
    if (resolvedKey) {
      effectiveAuth = `Bearer ${resolvedKey}`
    } else if (incomingAuth) {
      effectiveAuth = incomingAuth
    }

    if (effectiveAuth) {
      customHeaders["Authorization"] = effectiveAuth
    }

    return proxyToEngine({
      endpoint: result.proc.endpoint,
      path: "/chat/completions",
      body: engineBody,
      headers: customHeaders,
      modelId: model.id,
      modelName: model.name,
      engineKind: result.proc.engineKind,
      clientHeader: c.req.header("x-homestead-client"),
    })
  })

  return app
}
