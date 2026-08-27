import { describe, it, expect } from "bun:test"
import { resolve, join } from "node:path"
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  parseHomesteadfile,
  validateHomesteadfile,
  homesteadfileToModelRecord,
  serializeHomesteadfile,
  generateDefaultHomesteadfile,
} from "../../src/core/homesteadfile.js"
import type { Homesteadfile } from "../../src/types.js"

describe("Homesteadfile Specification & Parser", () => {
  const sampleYaml = `
schema_version: "v1"
name: "HomeCoder-Q4"
version: "1.0.0"
author: "Homestead Labs"
description: "Homestead Sovereign AI Operator & RL-Trained Code Intelligence Fleet"

base:
  source: "hf-hub"
  id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF"
  quantization: "Q4_K_M"
  format: "gguf"

adapters:
  - name: "homecoder-grpo-reasoning"
    source: "modal-volume"
    path: "/models/homecoder-grpo-v1-lora"
    merge_strategy: "lora"

engine:
  preferred: "llama.cpp"
  hardware_matrix:
    gpu_min_vram_gb: 8
    cuda_compute_capability: "sm_70"
    supported_accelerators:
      - "metal"
      - "cuda"
      - "rocm"
      - "cpu"
    cpu_fallback: true

fleet_arbitrage:
  primary:
    tier: "local-llama-cpp"
    provider: "local"
    accelerator: "metal-m-series"
    max_cost_per_hour: 0.00
  escalation:
    tier: "modal-l4"
    provider: "modal"
    accelerator: "nvidia-l4"
    max_cost_per_hour: 0.80
    triggers:
      timeout_seconds: 30
      hardware_failure_count: 3
      verifier_score_threshold: 0.85
  fallback:
    tier: "modal-a100"
    provider: "modal"
    accelerator: "nvidia-a100-40gb"
    max_cost_per_hour: 2.10
    triggers:
      timeout_seconds: 60
      hardware_failure_count: 5
      verifier_score_threshold: 0.95

system_contract:
  template: "chatml"
  reasoning:
    open_tag: "<think>"
    close_tag: "</think>"
    max_thinking_tokens: 8192
  tool_schema:
    format: "pi-json"
    allowed_tools:
      - "read"
      - "write"
      - "edit"
      - "bash"
      - "grep_search"
      - "find_by_name"

observability:
  log_sqlite: true
  track_tokens_per_sec: true
  composite_verifier:
    enabled: true
    rubric: "prime-intellect-verifiers-v1"
    min_pass_rate: 0.95
`

  describe("parseHomesteadfile", () => {
    it("parses a valid YAML string into a Homesteadfile", () => {
      const spec = parseHomesteadfile(sampleYaml)
      expect(spec.schema_version).toBe("v1")
      expect(spec.name).toBe("HomeCoder-Q4")
      expect(spec.base.source).toBe("hf-hub")
      expect(spec.base.id).toBe("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF")
      expect(spec.base.quantization).toBe("Q4_K_M")
      expect(spec.base.format).toBe("gguf")
      expect(spec.adapters?.length).toBe(1)
      expect(spec.adapters?.[0].name).toBe("homecoder-grpo-reasoning")
      expect(spec.engine?.preferred).toBe("llama.cpp")
      expect(spec.engine?.hardware_matrix?.gpu_min_vram_gb).toBe(8)
      expect(spec.fleet_arbitrage?.primary?.tier).toBe("local-llama-cpp")
      expect(spec.fleet_arbitrage?.escalation?.triggers?.timeout_seconds).toBe(30)
      expect(spec.system_contract?.reasoning?.open_tag).toBe("<think>")
      expect(spec.system_contract?.tool_schema?.format).toBe("pi-json")
      expect(spec.observability?.composite_verifier?.enabled).toBe(true)
    })

    it("parses a valid JSON string into a Homesteadfile", () => {
      const jsonStr = JSON.stringify({
        schema_version: "v1alpha",
        name: "Minimal-Model",
        base: {
          source: "ollama",
          id: "llama3.2:3b",
        },
      })
      const spec = parseHomesteadfile(jsonStr)
      expect(spec.schema_version).toBe("v1alpha")
      expect(spec.name).toBe("Minimal-Model")
      expect(spec.base.source).toBe("ollama")
      expect(spec.base.id).toBe("llama3.2:3b")
    })

    it("parses from a real file path", () => {
      const examplePath = resolve(import.meta.dir, "../../examples/Homesteadfile.homecoder.yaml")
      const spec = parseHomesteadfile(examplePath)
      expect(spec.name).toBe("HomeCoder-Q4")
      expect(spec.schema_version).toBe("v1")
      expect(spec.base.source).toBe("hf-hub")
    })

    it("throws an error for empty content or missing file", () => {
      expect(() => parseHomesteadfile("")).toThrow("Homesteadfile content is empty")
      expect(() => parseHomesteadfile("   ")).toThrow("Homesteadfile content is empty")
      expect(() => parseHomesteadfile("non_existent_file_path.yaml")).toThrow()
    })

    it("throws an error for malformed YAML / non-object content", () => {
      expect(() => parseHomesteadfile("just a plain string")).toThrow()
      expect(() => parseHomesteadfile("12345")).toThrow()
      expect(() => parseHomesteadfile("- item1\n- item2")).toThrow()
    })
  })

  describe("validateHomesteadfile", () => {
    it("validates a minimal valid object", () => {
      const valid = {
        schema_version: "v1",
        name: "test-model",
        base: {
          source: "gguf-file",
          id: "./models/qwen.gguf",
        },
      }
      const validated = validateHomesteadfile(valid)
      expect(validated.name).toBe("test-model")
    })

    it("fails when schema_version is invalid", () => {
      const invalid = {
        schema_version: "v2",
        name: "test-model",
        base: { source: "hf-hub", id: "test/repo" },
      }
      expect(() => validateHomesteadfile(invalid)).toThrow()
    })

    it("fails when base.source is invalid", () => {
      const invalid = {
        schema_version: "v1",
        name: "test-model",
        base: { source: "invalid-source", id: "test/repo" },
      }
      expect(() => validateHomesteadfile(invalid)).toThrow()
    })

    it("fails when base.id is empty", () => {
      const invalid = {
        schema_version: "v1",
        name: "test-model",
        base: { source: "hf-hub", id: "" },
      }
      expect(() => validateHomesteadfile(invalid)).toThrow()
    })

    it("fails when tool_schema.format is invalid", () => {
      const invalid = {
        schema_version: "v1",
        name: "test-model",
        base: { source: "hf-hub", id: "test/repo" },
        system_contract: {
          tool_schema: {
            format: "unknown-format",
          },
        },
      }
      expect(() => validateHomesteadfile(invalid)).toThrow()
    })
  })

  describe("homesteadfileToModelRecord", () => {
    it("converts hf-hub spec to ModelRecord", () => {
      const spec = parseHomesteadfile(sampleYaml)
      const record = homesteadfileToModelRecord(spec)

      expect(record.id).toBe("homestead-homecoder-q4")
      expect(record.name).toBe("HomeCoder-Q4")
      expect(record.source).toBe("hf-hub")
      expect(record.sourceId).toBe("Qwen/Qwen2.5-Coder-7B-Instruct-GGUF")
      expect(record.format).toBe("gguf")
      expect(record.quantization).toBe("Q4_K_M")
      expect(record.engine).toBe("llama.cpp")
      expect(record.status).toBe("discovered")
      expect(record.metadata.tags).toContain("weights")
      expect(record.metadata.tags).toContain("homesteadfile")
      expect(record.metadata.tags).toContain("adapters")
      expect(record.metadata.tags).toContain("fleet-arbitrage")
      expect(record.metadata.homesteadfile).toBeDefined()
    })

    it("resolves relative path for gguf-file when basePath is provided", () => {
      const spec: Homesteadfile = {
        schema_version: "v1",
        name: "Local-GGUF",
        base: {
          source: "gguf-file",
          id: "models/test.gguf",
        },
      }
      const record = homesteadfileToModelRecord(spec, "/custom/dir")
      expect(record.path).toBe("/custom/dir/models/test.gguf")
      expect(record.engine).toBe("llama.cpp")
      expect(record.format).toBe("gguf")
    })

    it("infers default engine for ollama and mlx sources when preferred is auto", () => {
      const ollamaSpec: Homesteadfile = {
        schema_version: "v1",
        name: "Ollama-Model",
        base: { source: "ollama", id: "deepseek-coder:6.7b" },
        engine: { preferred: "auto" },
      }
      const ollamaRec = homesteadfileToModelRecord(ollamaSpec)
      expect(ollamaRec.engine).toBe("ollama")

      const mlxSpec: Homesteadfile = {
        schema_version: "v1",
        name: "MLX-Model",
        base: { source: "mlx", id: "mlx-community/Qwen2.5-Coder-7B" },
      }
      const mlxRec = homesteadfileToModelRecord(mlxSpec)
      expect(mlxRec.engine).toBe("mlx")
      expect(mlxRec.format).toBe("mlx")
    })

    it("respects modal engine preference", () => {
      const modalSpec: Homesteadfile = {
        schema_version: "v1",
        name: "Modal-Fleet",
        base: { source: "hf-hub", id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
        engine: { preferred: "modal" },
      }
      const modalRec = homesteadfileToModelRecord(modalSpec)
      expect(modalRec.engine).toBe("modal")
    })
  })

  describe("serializeHomesteadfile & round-trip", () => {
    it("serializes to valid YAML and round-trips cleanly", () => {
      const original = generateDefaultHomesteadfile({ name: "Custom-Fleet" })
      const yamlOutput = serializeHomesteadfile(original)
      expect(typeof yamlOutput).toBe("string")
      expect(yamlOutput).toContain("name: Custom-Fleet")
      expect(yamlOutput).toContain('schema_version: v1')

      const parsedAgain = parseHomesteadfile(yamlOutput)
      expect(parsedAgain.name).toBe("Custom-Fleet")
      expect(parsedAgain.schema_version).toBe("v1")
      expect(parsedAgain.base.source).toBe(original.base.source)
      expect(parsedAgain.engine?.preferred).toBe(original.engine?.preferred)
    })
  })

  describe("generateDefaultHomesteadfile", () => {
    it("generates a complete valid default Homesteadfile", () => {
      const def = generateDefaultHomesteadfile()
      expect(def.schema_version).toBe("v1")
      expect(def.name).toBe("HomeCoder-Q4")
      expect(def.base.source).toBe("hf-hub")
      expect(def.adapters?.length).toBeGreaterThan(0)
      expect(def.engine?.hardware_matrix).toBeDefined()
      expect(def.fleet_arbitrage?.primary).toBeDefined()
      expect(def.fleet_arbitrage?.escalation).toBeDefined()
      expect(def.fleet_arbitrage?.fallback).toBeDefined()
      expect(def.system_contract?.reasoning).toBeDefined()
      expect(def.observability?.composite_verifier).toBeDefined()
    })
  })
})
