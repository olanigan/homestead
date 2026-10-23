import { Database } from "bun:sqlite"
import { join } from "node:path"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import type { ServingEventEnvelope, ServingSession, ObsStats, ServingEventPayload, ServingEventType, BenchmarkRecord } from "./types.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  model_id     TEXT NOT NULL,
  model_name   TEXT NOT NULL,
  engine_kind  TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  first_ts     TEXT NOT NULL,
  last_ts      TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  model_name   TEXT NOT NULL,
  engine_kind  TEXT NOT NULL,
  pool         TEXT NOT NULL DEFAULT 'default',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id             TEXT PRIMARY KEY,
  suite          TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  model_name     TEXT NOT NULL,
  label          TEXT NOT NULL,
  config_json    TEXT NOT NULL,
  workload_json  TEXT NOT NULL,
  prompt_tokens  INTEGER,
  output_tokens  INTEGER,
  total_tokens   INTEGER,
  ttft_ms        REAL,
  prompt_tps     REAL,
  completion_tps REAL,
  total_ms       REAL,
  status         TEXT NOT NULL DEFAULT 'completed',
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_obs_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_obs_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_obs_events_model ON events(model_id);
CREATE INDEX IF NOT EXISTS idx_benchmarks_suite ON benchmarks(suite);
CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON benchmarks(model_id);
CREATE INDEX IF NOT EXISTS idx_benchmarks_created ON benchmarks(created_at);
`

function defaultDbPath(): string {
  const oldDir = join(homedir(), ".localai")
  const newDir = join(homedir(), ".homestead")
  const dir = existsSync(newDir) || !existsSync(oldDir) ? newDir : oldDir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, "obs.db")
}

export class ObsDb {
  private db: Database

  constructor(path?: string) {
    const dbPath = path || process.env.HOMESTEAD_OBS_DB_PATH || process.env.LAI_OBS_DB_PATH || defaultDbPath()
    const dir = join(dbPath, "..")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = new Database(dbPath)
    this.db.run("PRAGMA busy_timeout = 5000")
    try { this.db.run("PRAGMA journal_mode = WAL") } catch { /* best effort — WAL may fail under concurrent access */ }
    this.db.run(SCHEMA)
  }

  insertEvent(event: ServingEventEnvelope<ServingEventPayload>): boolean {
    try {
      this.db.run(`
        INSERT OR IGNORE INTO events
          (event_id, session_id, seq, ts, type, model_id, model_name, engine_kind, pool, tags_json, payload_json)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        event.event_id,
        event.session_id,
        event.seq,
        event.ts,
        event.type,
        event.model_id,
        event.model_name,
        event.engine_kind,
        event.pool,
        JSON.stringify(event.tags),
        JSON.stringify(event.payload),
      ])
      return true
    } catch {
      return false
    }
  }

  upsertSession(session: ServingSession): void {
    try {
      const q = this.db.query(`
        INSERT INTO sessions
          (session_id, model_id, model_name, engine_kind, pool, tags_json, first_ts, last_ts, event_count, status)
        VALUES
          ($session_id, $model_id, $model_name, $engine_kind, $pool, $tags_json, $first_ts, $last_ts, $event_count, $status)
        ON CONFLICT(session_id) DO UPDATE SET
          last_ts = excluded.last_ts,
          event_count = excluded.event_count,
          status = excluded.status
      `)
      q.run({
        $session_id: session.session_id,
        $model_id: session.model_id,
        $model_name: session.model_name,
        $engine_kind: session.engine_kind,
        $pool: session.pool,
        $tags_json: JSON.stringify(session.tags),
        $first_ts: session.first_ts,
        $last_ts: session.last_ts,
        $event_count: session.event_count,
        $status: session.status,
      })
    } catch {
      // best effort — a locked/read-only db must never break serving operations
    }
  }

  getActiveSessionByModel(modelId: string): ServingSession | null {
    const q = this.db.query(`
      SELECT session_id, model_id, model_name, engine_kind, pool, tags_json,
             first_ts, last_ts, event_count, status
      FROM sessions
      WHERE model_id = $model_id AND status = 'active'
      ORDER BY last_ts DESC LIMIT 1
    `)
    const row = q.get({ $model_id: modelId }) as ServingSession | undefined
    return row || null
  }

  getSessions(limit = 50): ServingSession[] {
    const q = this.db.query(`
      SELECT session_id, model_id, model_name, engine_kind, pool, tags_json,
             first_ts, last_ts, event_count, status
      FROM sessions ORDER BY last_ts DESC LIMIT $limit
    `)
    return q.all({ $limit: limit }) as ServingSession[]
  }

  getSessionEvents(sessionId: string, since?: string): ServingEventEnvelope<ServingEventPayload>[] {
    if (since) {
      const q = this.db.query(`
        SELECT event_id, session_id, seq, ts, type, model_id, model_name,
               engine_kind, pool, tags_json, payload_json
        FROM events
        WHERE session_id = $session_id AND ts > $since
        ORDER BY seq ASC
      `)
      return this.toEvents(q.all({ $session_id: sessionId, $since: since }))
    }
    const q = this.db.query(`
      SELECT event_id, session_id, seq, ts, type, model_id, model_name,
             engine_kind, pool, tags_json, payload_json
      FROM events
      WHERE session_id = $session_id
      ORDER BY seq ASC
    `)
    return this.toEvents(q.all({ $session_id: sessionId }))
  }

  getRecentEvents(limit = 100): ServingEventEnvelope<ServingEventPayload>[] {
    const q = this.db.query(`
      SELECT event_id, session_id, seq, ts, type, model_id, model_name,
             engine_kind, pool, tags_json, payload_json
      FROM events ORDER BY ts DESC LIMIT $limit
    `)
    return this.toEvents(q.all({ $limit: limit }))
  }

  stats(): ObsStats {
    const s = this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM sessions) as total_sessions,
        (SELECT COUNT(*) FROM sessions WHERE status = 'active') as active_sessions,
        (SELECT COUNT(*) FROM events) as total_events,
        (SELECT COUNT(*) FROM events WHERE type = 'request') as total_requests,
        (SELECT COUNT(*) FROM events WHERE type = 'error') as total_errors
    `).get() as { total_sessions: number; active_sessions: number; total_events: number; total_requests: number; total_errors: number }

    const byTypeRows = this.db.query(`
      SELECT type, COUNT(*) as count FROM events GROUP BY type
    `).all() as { type: string; count: number }[]

    const by_type: Record<string, number> = {}
    for (const row of byTypeRows) {
      by_type[row.type] = row.count
    }

    return {
      total_sessions: s.total_sessions,
      active_sessions: s.active_sessions,
      total_events: s.total_events,
      total_requests: s.total_requests,
      total_errors: s.total_errors,
      by_type,
    }
  }

  insertBenchmark(record: BenchmarkRecord): boolean {
    try {
      this.db.run(`
        INSERT OR REPLACE INTO benchmarks
          (id, suite, model_id, model_name, label, config_json, workload_json, prompt_tokens, output_tokens, total_tokens, ttft_ms, prompt_tps, completion_tps, total_ms, status, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.id,
        record.suite,
        record.model_id,
        record.model_name,
        record.label,
        JSON.stringify(record.config),
        JSON.stringify(record.workload),
        record.prompt_tokens ?? null,
        record.output_tokens ?? null,
        record.total_tokens ?? null,
        record.ttft_ms ?? null,
        record.prompt_tps ?? null,
        record.completion_tps ?? null,
        record.total_ms,
        record.status,
        record.created_at,
      ])
      return true
    } catch {
      return false
    }
  }

  getBenchmarks(filter?: { suite?: string; model_id?: string; limit?: number }): BenchmarkRecord[] {
    const conditions: string[] = []
    const params: Record<string, unknown> = {}
    if (filter?.suite) {
      conditions.push("suite = $suite")
      params.$suite = filter.suite
    }
    if (filter?.model_id) {
      conditions.push("model_id = $model_id")
      params.$model_id = filter.model_id
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const limit = filter?.limit ?? 100
    params.$limit = limit

    const q = this.db.query(`
      SELECT id, suite, model_id, model_name, label, config_json, workload_json, prompt_tokens, output_tokens, total_tokens, ttft_ms, prompt_tps, completion_tps, total_ms, status, created_at
      FROM benchmarks
      ${where}
      ORDER BY created_at DESC
      LIMIT $limit
    `)
    const rows = q.all(params as any) as RawBenchmarkRow[]
    return rows.map((r) => ({
      id: r.id,
      suite: r.suite,
      model_id: r.model_id,
      model_name: r.model_name,
      label: r.label,
      config: JSON.parse(r.config_json),
      workload: JSON.parse(r.workload_json),
      prompt_tokens: r.prompt_tokens ?? undefined,
      output_tokens: r.output_tokens ?? undefined,
      total_tokens: r.total_tokens ?? undefined,
      ttft_ms: r.ttft_ms ?? undefined,
      prompt_tps: r.prompt_tps ?? undefined,
      completion_tps: r.completion_tps ?? undefined,
      total_ms: r.total_ms,
      status: r.status as "completed" | "failed",
      created_at: r.created_at,
    }))
  }

  deleteBenchmarks(suite?: string): void {
    if (suite) {
      this.db.run("DELETE FROM benchmarks WHERE suite = ?", [suite])
    } else {
      this.db.run("DELETE FROM benchmarks")
    }
  }

  close(): void {
    this.db.close()
  }

  private toEvents(rows: unknown[]): ServingEventEnvelope<ServingEventPayload>[] {
    return (rows as RawEventRow[]).map((r) => ({
      event_id: r.event_id,
      session_id: r.session_id,
      seq: r.seq,
      ts: r.ts,
      type: r.type as ServingEventType,
      model_id: r.model_id,
      model_name: r.model_name,
      engine_kind: r.engine_kind,
      pool: r.pool,
      tags: JSON.parse(r.tags_json),
      payload: JSON.parse(r.payload_json),
    }))
  }
}

interface RawEventRow {
  event_id: string
  session_id: string
  seq: number
  ts: string
  type: string
  model_id: string
  model_name: string
  engine_kind: string
  pool: string
  tags_json: string
  payload_json: string
}

interface RawBenchmarkRow {
  id: string
  suite: string
  model_id: string
  model_name: string
  label: string
  config_json: string
  workload_json: string
  prompt_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  ttft_ms: number | null
  prompt_tps: number | null
  completion_tps: number | null
  total_ms: number
  status: string
  created_at: string
}
