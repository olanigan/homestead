export type ModelSource = "ollama" | "hf-hub" | "gguf-file" | "mlx" | "engine-probe" | "imported" | "modal"

export type ModelFormat = "gguf" | "safetensors" | "mlx" | "pt" | "pth" | "onnx" | "aimodel" | "unknown"

export type ModelStatus = "discovered" | "downloading" | "incomplete" | "serving" | "stopped" | "error"

export type ModelTag = "weights" | "vocab" | "cloud" | "incomplete" | "unknown"

export type EngineKind = "ollama" | "llama.cpp" | "hf-transformers" | "mlx" | "modal"

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
