import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, dirname } from "node:path"
import YAML from "yaml"
import { z } from "zod"
import type {
  Homesteadfile,
  HomesteadfileSchemaVersion,
  HomesteadfileBase,
  HomesteadfileAdapter,
  HomesteadfileEngine,
  HomesteadfileFleetArbitrage,
  HomesteadfileSystemContract,
  HomesteadfileObservability,
  ModelRecord,
  EngineKind,
} from "../types.js"

// ---------------------------------------------------------------------------
// Zod Validation Schemas
// ---------------------------------------------------------------------------

export const HomesteadfileBaseSchema = z.object({
  source: z.enum(["hf-hub", "gguf-file", "ollama", "mlx"]),
  id: z.string().min(1, "Base model id/path cannot be empty"),
  quantization: z.string().optional(),
  format: z.enum(["gguf", "safetensors", "mlx", "pt", "pth", "onnx", "aimodel", "unknown"]).optional(),
})

export const HomesteadfileAdapterSchema = z.object({
  name: z.string().min(1, "Adapter name is required"),
  source: z.string().optional(),
  path: z.string().min(1, "Adapter path is required"),
  merge_strategy: z.enum(["lora", "qlora", "linear", "ties", "dare"]).or(z.string()).optional(),
})

export const HomesteadfileHardwareMatrixSchema = z
  .object({
    gpu_min_vram_gb: z.number().nonnegative().optional(),
    cuda_compute_capability: z.string().optional(),
    supported_accelerators: z.array(z.string()).optional(),
    cpu_fallback: z.boolean().optional(),
  })
  .passthrough()

export const HomesteadfileEngineSchema = z.object({
  preferred: z.enum(["auto", "llama.cpp", "mlx", "ollama", "modal"]).optional(),
  hardware_matrix: HomesteadfileHardwareMatrixSchema.optional(),
})

export const HomesteadfileFleetArbitrageTriggerSchema = z
  .object({
    timeout_seconds: z.number().nonnegative().optional(),
    hardware_failure_count: z.number().nonnegative().optional(),
    verifier_score_threshold: z.number().min(0).max(1).optional(),
  })
  .passthrough()

export const HomesteadfileFleetTierSchema = z
  .object({
    tier: z.string().min(1, "Tier name is required"),
    provider: z.string().optional(),
    accelerator: z.string().optional(),
    max_cost_per_hour: z.number().nonnegative().optional(),
    triggers: HomesteadfileFleetArbitrageTriggerSchema.optional(),
  })
  .passthrough()

export const HomesteadfileFleetArbitrageSchema = z.object({
  primary: HomesteadfileFleetTierSchema.optional(),
  escalation: HomesteadfileFleetTierSchema.optional(),
  fallback: HomesteadfileFleetTierSchema.optional(),
})

export const HomesteadfileReasoningSchema = z.object({
  open_tag: z.string().optional(),
  close_tag: z.string().optional(),
  max_thinking_tokens: z.number().nonnegative().optional(),
})

export const HomesteadfileToolSchemaFormatSchema = z.enum(["pi-json", "xml-tool-call", "openai-functions"])

export const HomesteadfileToolSchemaSchema = z.object({
  format: HomesteadfileToolSchemaFormatSchema.optional(),
  allowed_tools: z.array(z.string()).optional(),
})

export const HomesteadfileSystemContractSchema = z.object({
  template: z.string().optional(),
  reasoning: HomesteadfileReasoningSchema.optional(),
  tool_schema: HomesteadfileToolSchemaSchema.optional(),
})

export const HomesteadfileCompositeVerifierSchema = z
  .object({
    enabled: z.boolean().optional(),
    rubric: z.string().optional(),
    min_pass_rate: z.number().min(0).max(1).optional(),
  })
  .passthrough()

export const HomesteadfileObservabilitySchema = z.object({
  log_sqlite: z.boolean().optional(),
  track_tokens_per_sec: z.boolean().optional(),
  composite_verifier: HomesteadfileCompositeVerifierSchema.optional(),
})

export const HomesteadfileZodSchema = z.object({
  schema_version: z.enum(["v1alpha", "v1"]),
  name: z.string().min(1, "Model/fleet name is required"),
  version: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  base: HomesteadfileBaseSchema,
  adapters: z.array(HomesteadfileAdapterSchema).optional(),
  engine: HomesteadfileEngineSchema.optional(),
  fleet_arbitrage: HomesteadfileFleetArbitrageSchema.optional(),
  system_contract: HomesteadfileSystemContractSchema.optional(),
  observability: HomesteadfileObservabilitySchema.optional(),
})

// ---------------------------------------------------------------------------
// Parser & Validator Functions
// ---------------------------------------------------------------------------

/**
 * Validate an unknown object against the Homesteadfile schema.
 * Throws a ZodError or descriptive Error if invalid.
 */
export function validateHomesteadfile(input: unknown): Homesteadfile {
  return HomesteadfileZodSchema.parse(input) as Homesteadfile
}

/**
 * Parse a Homesteadfile from a raw string (YAML or JSON) or from a file path.
 */
export function parseHomesteadfile(contentOrPath: string): Homesteadfile {
  let content = contentOrPath.trim()

  // If contentOrPath is a valid existing path on disk, read it
  if (contentOrPath.length < 4096 && !contentOrPath.includes("\n") && existsSync(contentOrPath)) {
    try {
      content = readFileSync(contentOrPath, "utf-8")
    } catch (err) {
      throw new Error(`Failed to read Homesteadfile at ${contentOrPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!content) {
    throw new Error("Homesteadfile content is empty")
  }

  let rawData: unknown
  try {
    rawData = YAML.parse(content)
  } catch (yamlErr) {
    // If YAML parse failed, attempt JSON parse as fallback
    try {
      rawData = JSON.parse(content)
    } catch {
      throw new Error(`Failed to parse Homesteadfile as YAML or JSON: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`)
    }
  }

  if (typeof rawData !== "object" || rawData === null) {
    throw new Error("Invalid Homesteadfile structure: expected a YAML or JSON mapping/object")
  }

  return validateHomesteadfile(rawData)
}

/**
 * Convert a parsed Homesteadfile specification into a Homestead ModelRecord.
 */
export function homesteadfileToModelRecord(spec: Homesteadfile, basePath?: string): ModelRecord {
  const sanitizedId = `homestead-${spec.name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-")}`
  const now = new Date().toISOString()

  let resolvedPath = spec.base.id
  let sizeBytes = 0

  if (spec.base.source === "gguf-file") {
    resolvedPath = basePath ? resolve(basePath, spec.base.id) : resolve(spec.base.id)
    if (existsSync(resolvedPath)) {
      try {
        const st = statSync(resolvedPath)
        sizeBytes = st.size
      } catch {
        // Leave sizeBytes as 0 if stat fails
      }
    }
  }

  const format = spec.base.format || (spec.base.source === "gguf-file" ? "gguf" : spec.base.source === "mlx" ? "mlx" : "gguf")
  const quantization = spec.base.quantization || null

  let engineKind: EngineKind | null = null
  if (spec.engine?.preferred && spec.engine.preferred !== "auto") {
    engineKind = spec.engine.preferred as EngineKind
  } else {
    if (spec.base.source === "gguf-file") {
      engineKind = "llama.cpp"
    } else if (spec.base.source === "ollama") {
      engineKind = "ollama"
    } else if (spec.base.source === "mlx") {
      engineKind = "mlx"
    }
  }

  const tags: string[] = ["weights", "homesteadfile"]
  if (spec.adapters && spec.adapters.length > 0) {
    tags.push("adapters")
  }
  if (spec.fleet_arbitrage) {
    tags.push("fleet-arbitrage")
  }

  const metadata: Record<string, unknown> = {
    homesteadfile: spec,
    tags,
    version: spec.version,
    author: spec.author,
    description: spec.description,
    adapters: spec.adapters || [],
    system_contract: spec.system_contract,
    fleet_arbitrage: spec.fleet_arbitrage,
    observability: spec.observability,
    hardware_matrix: spec.engine?.hardware_matrix,
  }

  return {
    id: sanitizedId,
    name: spec.name,
    source: spec.base.source,
    sourceId: spec.base.id,
    path: resolvedPath,
    sizeBytes,
    format,
    quantization,
    engine: engineKind,
    status: "discovered",
    metadata,
    discoveredAt: now,
    updatedAt: now,
  }
}

/**
 * Serialize a Homesteadfile object to clean, canonical YAML.
 */
export function serializeHomesteadfile(spec: Homesteadfile): string {
  // Validate before serializing to guarantee schema adherence
  const validated = validateHomesteadfile(spec)
  return YAML.stringify(validated, {
    indent: 2,
    lineWidth: 120,
  })
}

/**
 * Generate a standard template Homesteadfile structure for quick bootstrap.
 */
export function generateDefaultHomesteadfile(overrides?: Partial<Homesteadfile>): Homesteadfile {
  const defaultSpec: Homesteadfile = {
    schema_version: "v1",
    name: "HomeCoder-Q4",
    version: "1.0.0",
    author: "Homestead Labs",
    description: "Homestead Sovereign AI Operator & RL-Trained Code Intelligence Fleet",
    base: {
      source: "hf-hub",
      id: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
      quantization: "Q4_K_M",
      format: "gguf",
    },
    adapters: [
      {
        name: "homecoder-grpo-reasoning",
        source: "modal-volume",
        path: "/models/homecoder-grpo-v1-lora",
        merge_strategy: "lora",
      },
    ],
    engine: {
      preferred: "llama.cpp",
      hardware_matrix: {
        gpu_min_vram_gb: 8,
        cuda_compute_capability: "sm_70",
        supported_accelerators: ["metal", "cuda", "rocm", "cpu"],
        cpu_fallback: true,
      },
    },
    fleet_arbitrage: {
      primary: {
        tier: "local-llama-cpp",
        provider: "local",
        accelerator: "metal-m-series",
        max_cost_per_hour: 0.0,
      },
      escalation: {
        tier: "modal-l4",
        provider: "modal",
        accelerator: "nvidia-l4",
        max_cost_per_hour: 0.8,
        triggers: {
          timeout_seconds: 30,
          hardware_failure_count: 3,
          verifier_score_threshold: 0.85,
        },
      },
      fallback: {
        tier: "modal-a100",
        provider: "modal",
        accelerator: "nvidia-a100-40gb",
        max_cost_per_hour: 2.1,
        triggers: {
          timeout_seconds: 60,
          hardware_failure_count: 5,
          verifier_score_threshold: 0.95,
        },
      },
    },
    system_contract: {
      template: "chatml",
      reasoning: {
        open_tag: "<think>",
        close_tag: "</think>",
        max_thinking_tokens: 8192,
      },
      tool_schema: {
        format: "pi-json",
        allowed_tools: ["read", "write", "edit", "bash", "grep_search", "find_by_name"],
      },
    },
    observability: {
      log_sqlite: true,
      track_tokens_per_sec: true,
      composite_verifier: {
        enabled: true,
        rubric: "prime-intellect-verifiers-v1",
        min_pass_rate: 0.95,
      },
    },
    ...overrides,
  }

  return validateHomesteadfile(defaultSpec)
}
