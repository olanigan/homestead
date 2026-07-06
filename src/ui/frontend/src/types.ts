export interface ModelRecord {
  id: string
  name: string
  source: string
  format: string
  sizeBytes: number
  quantization: string | null
  engine: string | null
  status: string
  path: string
  metadata: Record<string, unknown>
  discoveredAt: string
}

export interface EngineStatus {
  kind: string
  running: boolean
  modelsCount: number
  port: number | null
  version: string | null
  healthy: boolean
  error?: string
}

export interface ServingProcess {
  modelId: string
  engineKind: string
  port: number
  pid: number
  endpoint: string
  startedAt: string
}

export interface RegistryStats {
  totalModels: number
  bySource: Record<string, number>
  byStatus: Record<string, number>
  byFormat: Record<string, number>
  totalSizeBytes: number
  servingCount: number
  incompleteCount: number
}

export interface DashboardData {
  engines: EngineStatus[]
  processes: ServingProcess[]
  stats: RegistryStats
}

export interface ObsStats {
  total_sessions: number
  active_sessions: number
  total_events: number
  total_requests: number
  total_errors: number
  by_type: Record<string, number>
}

export interface ServingSession {
  session_id: string
  model_id: string
  model_name: string
  engine_kind: string
  pool: string
  tags: string[]
  first_ts: string
  last_ts: string
  event_count: number
  status: "active" | "completed"
}

export interface ServingEvent {
  event_id: string
  session_id: string
  seq: number
  ts: string
  type: string
  model_id: string
  model_name: string
  engine_kind: string
  pool: string
  tags: string[]
  payload: Record<string, unknown>
}
