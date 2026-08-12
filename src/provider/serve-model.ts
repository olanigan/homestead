import type { Registry } from "../core/registry.js"
import type { ModelRecord, ServingProcess } from "../types.js"
import { engineManager as defaultEngineManager, isStaleProcess } from "../engines/index.js"

export interface ServeModelError {
  status: 503
  message: string
  type: "server_error"
  code: "engine_unavailable" | "serve_failed"
}

export type ServeModelResult = { proc: ServingProcess; error?: undefined } | { proc?: undefined; error: ServeModelError }

type EngineManagerLike = Pick<typeof defaultEngineManager, "selectEngine" | "getRunningProcesses">

function engineUnavailable(model: ModelRecord): ServeModelError {
  return { status: 503, message: `No compatible engine for format: ${model.format}`, type: "server_error", code: "engine_unavailable" }
}

async function spawn(model: ModelRecord, registry: Registry, engineManager: EngineManagerLike): Promise<ServeModelResult> {
  const engine = engineManager.selectEngine(model)
  if (!engine) return { error: engineUnavailable(model) }
  try {
    const proc = await engine.serve(model, 8080)
    registry.updateStatus(model.id, "serving")
    return { proc }
  } catch (err) {
    return { error: { status: 503, message: `Failed to serve model: ${err}`, type: "server_error", code: "serve_failed" } }
  }
}

// Shared by the /chat/completions and /completions routes: reuses a running
// process for this model when one exists and is still valid, respawning it
// when missing or when its ctxSize has drifted from the currently resolved
// value (see isStaleProcess — a process launched before a model's GGUF
// context_length metadata was known would otherwise be reused forever).
export async function ensureServingProcess(
  model: ModelRecord,
  registry: Registry,
  engineManager: EngineManagerLike = defaultEngineManager
): Promise<ServeModelResult> {
  if (model.status !== "serving") {
    return spawn(model, registry, engineManager)
  }

  const processes = engineManager.getRunningProcesses()
  const proc = processes.find((p) => p.modelId === model.id)
  if (!proc || isStaleProcess(proc, model)) {
    registry.updateStatus(model.id, "stopped")
    return spawn(model, registry, engineManager)
  }

  return { proc }
}
