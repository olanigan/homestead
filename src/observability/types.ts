export type ServingEventType =
  | "model_loaded"
  | "model_unloaded"
  | "request"
  | "response"
  | "error"
  | "engine_status"

export interface ServingEventEnvelope<P = unknown> {
  event_id: string
  ts: string
  type: ServingEventType
  session_id: string
  model_id: string
  model_name: string
  engine_kind: string
  pool: string
  tags: string[]
  payload: P
  seq: number
}

export interface ModelLoadedPayload {
  endpoint: string
  port: number
  pid: number
  format: string
}

export interface ModelUnloadedPayload {
  reason: string
  duration_sec: number
  total_requests: number
}

export interface RequestPayload {
  request_id: string
  method: string
  path: string
  model: string
  client?: string
  input_tokens?: number
  max_tokens?: number
  temperature?: number
}

export interface ResponsePayload {
  request_id: string
  output_tokens?: number
  input_tokens?: number
  total_tokens?: number
  latency_ms: number
  status: number
  client?: string
}

export interface ErrorPayload {
  request_id?: string
  message: string
  code: string
}

export interface EngineStatusPayload {
  kind: string
  healthy: boolean
  running: boolean
  models_count: number
  port: number | null
  error?: string
  memory_mb?: number
}

export type ServingEventPayload =
  | ModelLoadedPayload
  | ModelUnloadedPayload
  | RequestPayload
  | ResponsePayload
  | ErrorPayload
  | EngineStatusPayload

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

export interface ObsStats {
  total_sessions: number
  active_sessions: number
  total_events: number
  total_requests: number
  total_errors: number
  by_type: Record<string, number>
}
