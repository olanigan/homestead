export type ModelSource = "ollama" | "hf-hub" | "gguf-file" | "mlx" | "engine-probe" | "imported" | "modal" | "deepseek" | "openrouter" | "remote"

export type ModelFormat = "gguf" | "safetensors" | "mlx" | "pt" | "pth" | "onnx" | "aimodel" | "unknown"

export type ModelStatus = "discovered" | "downloading" | "incomplete" | "serving" | "stopped" | "error"

export type ModelTag = "weights" | "vocab" | "cloud" | "incomplete" | "unknown"

export type EngineKind = "ollama" | "llama.cpp" | "hf-transformers" | "mlx" | "modal" | "remote" | "deepseek" | "openrouter"

export interface ModelRecord {
  id: string
  name: string
  source: ModelSource
  sourceId: string
  path: string
  sizeBytes: number
  format: ModelFormat
  quantization: string | null
  engine: EngineKind | null
  status: ModelStatus
  metadata: Record<string, unknown>
  discoveredAt: string
  updatedAt: string
}

export interface ServeOptions {
  detach?: boolean
}

export interface EngineAdapter {
  kind: EngineKind
  name: string
  priority: number
  canHandle(model: ModelRecord): boolean
  serve(model: ModelRecord, port: number, opts?: ServeOptions): Promise<ServingProcess>
  stop(process: ServingProcess): Promise<void>
  status(): Promise<EngineStatus>
  discover(): Promise<ModelRecord[]>
}

export interface ServingProcess {
  modelId: string
  engineKind: EngineKind
  port?: number
  pid?: number
  endpoint: string
  startedAt: string
  ctxSize?: number
}

export interface EngineStatus {
  kind: EngineKind
  running: boolean
  modelsCount: number
  port: number | null
  version: string | null
  healthy: boolean
  error?: string
}

export interface Scanner {
  name: string
  source: ModelSource
  priority: number
  scan(): Promise<ModelRecord[]>
}

export interface RegistryStats {
  totalModels: number
  bySource: Record<ModelSource, number>
  byStatus: Record<ModelStatus, number>
  byFormat: Record<ModelFormat, number>
  totalSizeBytes: number
  servingCount: number
  incompleteCount: number
}

export interface DiscoverResult {
  scanned: string[]
  found: number
  newModels: number
  updatedModels: number
  failedScanners: { name: string; error: string }[]
  elapsedMs: number
}

export interface CliOptions {
  port?: number
  source?: ModelSource
  format?: string
  json?: boolean
}

export interface StreamEvent {
  kind: "reasoning" | "content"
  text: string
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  stop?: string[]
}

// ---------------------------------------------------------------------------
// Homesteadfile (Universal Local Model & Fleet Specification) Interfaces
// ---------------------------------------------------------------------------

export type HomesteadfileSchemaVersion = "v1alpha" | "v1"

export type HomesteadfileBaseSource = "hf-hub" | "gguf-file" | "ollama" | "mlx"

export interface HomesteadfileBase {
  source: HomesteadfileBaseSource
  id: string
  quantization?: string
  format?: ModelFormat
}

export interface HomesteadfileAdapter {
  name: string
  source?: string
  path: string
  merge_strategy?: "lora" | "qlora" | "linear" | "ties" | "dare" | string
}

export type HomesteadfileEnginePreferred = "auto" | "llama.cpp" | "mlx" | "ollama" | "modal"

export interface HomesteadfileHardwareMatrix {
  gpu_min_vram_gb?: number
  cuda_compute_capability?: string
  supported_accelerators?: string[]
  cpu_fallback?: boolean
  [key: string]: unknown
}

export interface HomesteadfileEngine {
  preferred?: HomesteadfileEnginePreferred
  hardware_matrix?: HomesteadfileHardwareMatrix
}

export interface HomesteadfileFleetArbitrageTrigger {
  timeout_seconds?: number
  hardware_failure_count?: number
  verifier_score_threshold?: number
  [key: string]: unknown
}

export interface HomesteadfileFleetTier {
  tier: string
  provider?: string
  accelerator?: string
  max_cost_per_hour?: number
  triggers?: HomesteadfileFleetArbitrageTrigger
  [key: string]: unknown
}

export interface HomesteadfileFleetArbitrage {
  primary?: HomesteadfileFleetTier
  escalation?: HomesteadfileFleetTier
  fallback?: HomesteadfileFleetTier
}

export interface HomesteadfileReasoning {
  open_tag?: string
  close_tag?: string
  max_thinking_tokens?: number
}

export type HomesteadfileToolSchemaFormat = "pi-json" | "xml-tool-call" | "openai-functions"

export interface HomesteadfileToolSchema {
  format?: HomesteadfileToolSchemaFormat
  allowed_tools?: string[]
}

export interface HomesteadfileSystemContract {
  template?: string
  reasoning?: HomesteadfileReasoning
  tool_schema?: HomesteadfileToolSchema
}

export interface HomesteadfileCompositeVerifier {
  enabled?: boolean
  rubric?: string
  min_pass_rate?: number
  [key: string]: unknown
}

export interface HomesteadfileObservability {
  log_sqlite?: boolean
  track_tokens_per_sec?: boolean
  composite_verifier?: HomesteadfileCompositeVerifier
}

export interface Homesteadfile {
  schema_version: HomesteadfileSchemaVersion
  name: string
  version?: string
  author?: string
  description?: string
  base: HomesteadfileBase
  adapters?: HomesteadfileAdapter[]
  engine?: HomesteadfileEngine
  fleet_arbitrage?: HomesteadfileFleetArbitrage
  system_contract?: HomesteadfileSystemContract
  observability?: HomesteadfileObservability
}

