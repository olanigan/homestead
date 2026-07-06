import { randomUUID } from "node:crypto"
import { ObsDb } from "./db.js"
import type {
  ServingEventEnvelope,
  ServingEventPayload,
  ServingEventType,
  ModelLoadedPayload,
  ModelUnloadedPayload,
  RequestPayload,
  ResponsePayload,
  ErrorPayload,
  EngineStatusPayload,
} from "./types.js"
export interface ObsEmitterConfig {
  pool?: string
  tags?: string[]
  dbPath?: string
}

export class ObsEmitter {
  private db: ObsDb
  private seqCounters = new Map<string, number>()
  private pool: string
  private tags: string[]
  private enabled: boolean

  constructor(config?: ObsEmitterConfig) {
    this.db = new ObsDb(config?.dbPath)
    this.pool = config?.pool || "default"
    this.tags = config?.tags || []
    const obsEnv = process.env.HOMESTEAD_OBS_ENABLED ?? process.env.LAI_OBS_ENABLED
    this.enabled = obsEnv !== "false"
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(v: boolean): void {
    this.enabled = v
  }

  modelLoaded(sessionId: string, modelId: string, modelName: string, engineKind: string, payload: ModelLoadedPayload): void {
    this.emit("model_loaded", sessionId, modelId, modelName, engineKind, payload)
  }

  modelUnloaded(sessionId: string, modelId: string, modelName: string, engineKind: string, payload: ModelUnloadedPayload): void {
    this.emit("model_unloaded", sessionId, modelId, modelName, engineKind, payload)
    this.seqCounters.delete(sessionId)
  }

  request(sessionId: string, modelId: string, modelName: string, engineKind: string, payload: RequestPayload): void {
    this.emit("request", sessionId, modelId, modelName, engineKind, payload)
  }

  response(sessionId: string, modelId: string, modelName: string, engineKind: string, payload: ResponsePayload): void {
    this.emit("response", sessionId, modelId, modelName, engineKind, payload)
  }

  error(sessionId: string, modelId: string, modelName: string, engineKind: string, payload: ErrorPayload): void {
    this.emit("error", sessionId, modelId, modelName, engineKind, payload)
  }

  engineStatus(sessionId: string, engineKind: string, payload: EngineStatusPayload): void {
    this.emit("engine_status", sessionId, "", engineKind, engineKind, payload)
  }

  private emit(type: ServingEventType, sessionId: string, modelId: string, modelName: string, engineKind: string, payload: ServingEventPayload): void {
    if (!this.enabled) return

    const seq = (this.seqCounters.get(sessionId) ?? -1) + 1
    this.seqCounters.set(sessionId, seq)

    const event: ServingEventEnvelope<ServingEventPayload> = {
      event_id: randomUUID(),
      ts: new Date().toISOString(),
      type,
      session_id: sessionId,
      model_id: modelId,
      model_name: modelName,
      engine_kind: engineKind,
      pool: this.pool,
      tags: this.tags,
      payload,
      seq,
    }

    this.db.insertEvent(event)
    this.db.upsertSession({
      session_id: sessionId,
      model_id: modelId,
      model_name: modelName,
      engine_kind: engineKind,
      pool: this.pool,
      tags: this.tags,
      first_ts: event.ts,
      last_ts: event.ts,
      event_count: seq + 1,
      status: type === "model_unloaded" ? "completed" : "active",
    })

    this.broadcast(event)
  }

  private subscribers = new Set<(event: ServingEventEnvelope<ServingEventPayload>) => void>()

  subscribe(cb: (event: ServingEventEnvelope<ServingEventPayload>) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  private broadcast(event: ServingEventEnvelope<ServingEventPayload>): void {
    for (const cb of this.subscribers) {
      try { cb(event) } catch { /* ignore */ }
    }
  }

  getDb(): ObsDb {
    return this.db
  }

  ingestExternalEvent(event: ServingEventEnvelope<ServingEventPayload>): void {
    if (!this.enabled) return
    this.db.insertEvent(event as ServingEventEnvelope<ServingEventPayload>)
    this.db.upsertSession({
      session_id: event.session_id,
      model_id: "model_id" in event ? (event as ServingEventEnvelope).model_id : "",
      model_name: "model_name" in event ? (event as ServingEventEnvelope).model_name : "",
      engine_kind: "engine_kind" in event ? (event as ServingEventEnvelope).engine_kind : "homestead",
      pool: event.pool,
      tags: event.tags,
      first_ts: event.ts,
      last_ts: event.ts,
      event_count: event.seq + 1,
      status: event.type === "model_unloaded" ? "completed" : "active",
    })
    this.broadcast(event as ServingEventEnvelope<ServingEventPayload>)
  }

  close(): void {
    this.db.close()
  }
}

export const globalEmitter = new ObsEmitter({
  pool: "homestead",
  tags: ["homestead-ai"],
})
