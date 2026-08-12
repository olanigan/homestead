import { describe, test, expect } from "bun:test"
import { resolveCtxSize, isStaleProcess } from "../../src/engines/index.js"
import type { ModelRecord, ServingProcess } from "../../src/types.js"

function makeModel(metadata: Record<string, unknown> = {}): ModelRecord {
  const now = new Date().toISOString()
  return {
    id: "test-1",
    name: "Test Model",
    source: "hf-hub",
    sourceId: "source-1",
    path: "/tmp/model.gguf",
    sizeBytes: 1024,
    format: "gguf",
    quantization: "Q4_K_M",
    engine: "llama.cpp",
    status: "discovered",
    metadata,
    discoveredAt: now,
    updatedAt: now,
  }
}

describe("resolveCtxSize", () => {
  test("falls back to 4096 when context_length is missing", () => {
    expect(resolveCtxSize(makeModel({}))).toBe(4096)
  })

  test("falls back to 4096 when context_length is not a number", () => {
    expect(resolveCtxSize(makeModel({ context_length: "not-a-number" }))).toBe(4096)
  })

  test("falls back to 4096 when context_length is zero or negative", () => {
    expect(resolveCtxSize(makeModel({ context_length: 0 }))).toBe(4096)
    expect(resolveCtxSize(makeModel({ context_length: -1 }))).toBe(4096)
  })

  test("uses the model's real context_length when under the cap", () => {
    expect(resolveCtxSize(makeModel({ context_length: 8192 }))).toBe(8192)
  })

  test("caps context_length at 32768 for very large native windows", () => {
    expect(resolveCtxSize(makeModel({ context_length: 262144 }))).toBe(32768)
    expect(resolveCtxSize(makeModel({ context_length: 1048576 }))).toBe(32768)
  })
})

function makeProc(ctxSize: number | undefined): ServingProcess {
  return {
    modelId: "test-1",
    engineKind: "llama.cpp",
    port: 18766,
    pid: 1234,
    endpoint: "http://127.0.0.1:18766",
    startedAt: new Date().toISOString(),
    ctxSize,
  }
}

describe("isStaleProcess", () => {
  test("flags a process launched with the pre-fix 4096 default once metadata is known", () => {
    // Reproduces the Pi trace: ornith-1.0-9b served at 4096 (metadata not yet
    // scanned), then metadata later reports a real 32768 context_length —
    // the running process must be recognized as stale so it gets respawned.
    const model = makeModel({ context_length: 32768 })
    expect(isStaleProcess(makeProc(4096), model)).toBe(true)
  })

  test("does not flag a process already running at the resolved ctx size", () => {
    const model = makeModel({ context_length: 32768 })
    expect(isStaleProcess(makeProc(32768), model)).toBe(false)
  })

  test("does not flag a process with no recorded ctxSize (pre-upgrade persisted state)", () => {
    const model = makeModel({ context_length: 32768 })
    expect(isStaleProcess(makeProc(undefined), model)).toBe(false)
  })
})
