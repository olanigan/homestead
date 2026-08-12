import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "../../src/core/registry.js"
import { ensureServingProcess } from "../../src/provider/serve-model.js"
import type { ModelRecord, ServingProcess, EngineAdapter } from "../../src/types.js"

// Reproduces the Pi trace scenario at the route-decision level: a model is
// already "serving" via a process that was launched before its GGUF
// context_length metadata was known (ctxSize 4096), and the model's metadata
// now resolves to a larger context_length. ensureServingProcess() backs both
// /chat/completions and /completions — this is the actual wiring PR #17
// added; previously only the pure isStaleProcess() comparison was tested,
// not that a route-level caller actually respawns because of it.

function makeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const now = new Date().toISOString()
  return {
    id: "ornith-1",
    name: "ornith-1.0-9b-gguf",
    source: "hf-hub",
    sourceId: "source-1",
    path: "/tmp/ornith.gguf",
    sizeBytes: 1024,
    format: "gguf",
    quantization: "Q4_K_M",
    engine: "llama.cpp",
    status: "serving",
    metadata: { context_length: 32768 },
    discoveredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeFakeEngineManager(running: ServingProcess[]) {
  const serveCalls: Array<{ model: ModelRecord; port: number }> = []
  const fakeEngine: EngineAdapter = {
    kind: "llama.cpp",
    name: "fake-llama.cpp",
    priority: 1,
    canHandle: () => true,
    async serve(model, port) {
      serveCalls.push({ model, port })
      const sp: ServingProcess = {
        modelId: model.id,
        engineKind: "llama.cpp",
        port,
        pid: 999,
        endpoint: "http://127.0.0.1:1/fresh",
        startedAt: new Date().toISOString(),
        ctxSize: 32768,
      }
      return sp
    },
    async stop() {},
    async status() {
      return { kind: "llama.cpp", running: true, modelsCount: 0, port: null, version: null, healthy: true }
    },
    async discover() {
      return []
    },
  }
  return {
    serveCalls,
    engineManager: {
      selectEngine: () => fakeEngine,
      getRunningProcesses: () => running,
    },
  }
}

describe("ensureServingProcess", () => {
  let dir: string
  let registry: Registry

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "homestead-serve-model-"))
    registry = new Registry(join(dir, "models.db"))
  })

  afterAll(() => {
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("respawns when the running process's ctxSize has drifted from the resolved value", async () => {
    const model = makeModel()
    registry.upsert(model)
    const { engineManager, serveCalls } = makeFakeEngineManager([{
      modelId: model.id,
      engineKind: "llama.cpp",
      port: 1,
      pid: 111,
      endpoint: "http://127.0.0.1:1/stale",
      startedAt: new Date().toISOString(),
      ctxSize: 4096,
    }])

    const result = await ensureServingProcess(model, registry, engineManager)

    expect(result.error).toBeUndefined()
    expect(result.proc?.endpoint).toBe("http://127.0.0.1:1/fresh")
    expect(serveCalls.length).toBe(1)
    expect(registry.get(model.id)?.status).toBe("serving")
  })

  test("reuses the running process without respawning when ctxSize already matches", async () => {
    const model = makeModel({ id: "ornith-2", name: "ornith-2-match", sourceId: "source-2" })
    registry.upsert(model)
    const { engineManager, serveCalls } = makeFakeEngineManager([{
      modelId: model.id,
      engineKind: "llama.cpp",
      port: 1,
      pid: 222,
      endpoint: "http://127.0.0.1:1/already-serving",
      startedAt: new Date().toISOString(),
      ctxSize: 32768,
    }])

    const result = await ensureServingProcess(model, registry, engineManager)

    expect(result.error).toBeUndefined()
    expect(result.proc?.endpoint).toBe("http://127.0.0.1:1/already-serving")
    expect(serveCalls.length).toBe(0)
  })

  test("spawns fresh when status is serving but no matching running process is found", async () => {
    const model = makeModel({ id: "ornith-3", name: "ornith-3-orphaned", sourceId: "source-3" })
    registry.upsert(model)
    const { engineManager, serveCalls } = makeFakeEngineManager([])

    const result = await ensureServingProcess(model, registry, engineManager)

    expect(result.error).toBeUndefined()
    expect(result.proc?.endpoint).toBe("http://127.0.0.1:1/fresh")
    expect(serveCalls.length).toBe(1)
  })

  test("spawns when the model is not yet marked as serving", async () => {
    const model = makeModel({ id: "ornith-4", name: "ornith-4-cold", sourceId: "source-4", status: "discovered" })
    registry.upsert(model)
    const { engineManager, serveCalls } = makeFakeEngineManager([])

    const result = await ensureServingProcess(model, registry, engineManager)

    expect(result.error).toBeUndefined()
    expect(serveCalls.length).toBe(1)
    expect(registry.get(model.id)?.status).toBe("serving")
  })

  test("returns engine_unavailable when no engine can handle the model", async () => {
    const model = makeModel({ id: "ornith-5", name: "ornith-5-unservable", sourceId: "source-5", status: "discovered", format: "safetensors" })
    registry.upsert(model)
    const engineManager = { selectEngine: () => null, getRunningProcesses: () => [] }

    const result = await ensureServingProcess(model, registry, engineManager)

    expect(result.proc).toBeUndefined()
    expect(result.error?.code).toBe("engine_unavailable")
  })
})
