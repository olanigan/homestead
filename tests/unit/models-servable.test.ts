import { describe, test, expect } from "bun:test"
import { isServable } from "../../src/provider/models.js"
import type { ModelRecord } from "../../src/types.js"

function makeModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
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
    metadata: { tags: ["weights"] },
    discoveredAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("isServable", () => {
  test("gguf models are servable (llama.cpp adapter present)", () => {
    expect(isServable(makeModel({ format: "gguf" }))).toBe(true)
  })

  test("safetensors models are not servable (no hf-transformers adapter registered)", () => {
    expect(isServable(makeModel({ format: "safetensors", engine: "hf-transformers" }))).toBe(false)
  })

  test("mlx models are not servable (no mlx adapter registered)", () => {
    expect(isServable(makeModel({ format: "mlx", engine: "mlx" }))).toBe(false)
  })

  test("incomplete downloads are not servable", () => {
    expect(isServable(makeModel({ status: "incomplete" }))).toBe(false)
  })

  test("vocab-tagged files are not servable", () => {
    expect(isServable(makeModel({ metadata: { tags: ["vocab"] } }))).toBe(false)
  })

  test("cloud-tagged models are not servable", () => {
    expect(isServable(makeModel({ metadata: { tags: ["cloud"] } }))).toBe(false)
  })
})
