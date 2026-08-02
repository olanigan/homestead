import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ObsDb } from "../../src/observability/db.js"
import type { ServingEventEnvelope, ServingSession } from "../../src/observability/types.js"

const now = () => new Date().toISOString()

describe("ObsDb", () => {
  let dir: string
  let db: ObsDb

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "homestead-obs-"))
    db = new ObsDb(join(dir, "obs.db"))
  })

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("insertEvent stores an event and increments stats", () => {
    const event: ServingEventEnvelope<unknown> = {
      event_id: "evt-1",
      session_id: "sess-1",
      seq: 1,
      ts: now(),
      type: "model_loaded",
      model_id: "model-1",
      model_name: "LFM2-350M",
      engine_kind: "llama.cpp",
      pool: "default",
      tags: [],
      payload: {},
    }
    expect(db.insertEvent(event)).toBe(true)
    const stats = db.stats()
    expect(stats.total_events).toBe(1)
  })

  test("upsertSession creates a session that can be found as active", () => {
    const session: ServingSession = {
      session_id: "sess-1",
      model_id: "model-1",
      model_name: "LFM2-350M",
      engine_kind: "llama.cpp",
      pool: "default",
      tags: [],
      first_ts: now(),
      last_ts: now(),
      event_count: 1,
      status: "active",
    }
    db.upsertSession(session)
    const active = db.getActiveSessionByModel("model-1")
    expect(active?.session_id).toBe("sess-1")
  })

  test("getSessionEvents returns events in sequence order", () => {
    db.insertEvent({
      event_id: "evt-2",
      session_id: "sess-1",
      seq: 2,
      ts: now(),
      type: "model_unloaded",
      model_id: "model-1",
      model_name: "LFM2-350M",
      engine_kind: "llama.cpp",
      pool: "default",
      tags: [],
      payload: { reason: "user_stop" },
    })
    const events = db.getSessionEvents("sess-1")
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    expect(events[1]?.payload).toMatchObject({ reason: "user_stop" })
  })
})
