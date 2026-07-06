import { useObs } from "../hooks"
import type { ServingEvent } from "../types"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function eventColor(type: string): string {
  const colors: Record<string, string> = {
    model_loaded: "#10b981",
    model_unloaded: "#ef4444",
    request: "#3b82f6",
    response: "#8b5cf6",
    error: "#ef4444",
    engine_status: "#6b7280",
  }
  return colors[type] || "#6b7280"
}

function StatsPanel({ stats }: { stats: { total_sessions: number; active_sessions: number; total_events: number; total_requests: number; total_errors: number } | null }) {
  if (!stats) return null
  return (
    <div style={{ display: "flex", gap: 24, marginBottom: 24, flexWrap: "wrap" }}>
      {[
        { label: "Sessions", value: stats.total_sessions, sub: `${stats.active_sessions} active`, color: "#4f46e5" },
        { label: "Events", value: stats.total_events, color: "#3b82f6" },
        { label: "Requests", value: stats.total_requests, color: "#10b981" },
        { label: "Errors", value: stats.total_errors, color: stats.total_errors > 0 ? "#ef4444" : "#6b7280" },
      ].map((s) => (
        <div key={s.label} style={{
          padding: "12px 20px", borderRadius: 8, border: "1px solid #e5e7eb", backgroundColor: "#fff", minWidth: 120,
        }}>
          <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: s.color }}>{s.value}</div>
          {s.sub && <div style={{ fontSize: 11, color: "#9ca3af" }}>{s.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function SessionCard({ session, selected, onSelect }: {
  session: { session_id: string; model_name: string; engine_kind: string; status: string; event_count: number; last_ts: string }
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div
      onClick={() => onSelect(session.session_id)}
      style={{
        padding: "10px 14px", borderRadius: 6, border: `1px solid ${selected ? "#4f46e5" : "#e5e7eb"}`,
        backgroundColor: selected ? "#eef2ff" : "#fff", cursor: "pointer", marginBottom: 6,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: 13 }}>{session.model_name}</div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>{session.engine_kind} · {session.event_count} events</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: session.status === "active" ? "#10b981" : "#9ca3af",
        }} />
        <span style={{ fontSize: 11, color: "#6b7280" }}>{session.status}</span>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: ServingEvent }) {
  const payload = event.payload
  let detail = ""
  if (event.type === "model_loaded") detail = `:${(payload as any).port} · pid ${(payload as any).pid}`
  else if (event.type === "request") detail = `${(payload as any).model || ""} · ${(payload as any).input_tokens || "?"}t in`
  else if (event.type === "response") detail = `${(payload as any).output_tokens || 0}t out · ${(payload as any).latency_ms || 0}ms`
  else if (event.type === "error") detail = (payload as any).message || ""

  return (
    <div style={{
      display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid #f3f4f6",
      fontSize: 12, alignItems: "center",
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
        backgroundColor: eventColor(event.type),
      }} />
      <span style={{ color: "#6b7280", width: 80, flexShrink: 0, fontSize: 11, fontFamily: "monospace" }}>
        {event.ts.split("T")[1]?.split(".")[0] || event.ts}
      </span>
      <span style={{
        fontWeight: 500, width: 110, flexShrink: 0, color: eventColor(event.type), fontSize: 11,
      }}>
        {event.type.replace(/_/g, " ")}
      </span>
      <span style={{ color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {detail}
      </span>
    </div>
  )
}

export default function ObservabilityPanel() {
  const { stats, sessions, events, selectedSession, setSelectedSession, refresh } = useObs()

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Observability</h2>
        <button onClick={refresh} style={{
          padding: "4px 12px", fontSize: 12, borderRadius: 4, border: "1px solid #d1d5db",
          backgroundColor: "#fff", cursor: "pointer", color: "#374151",
        }}>Refresh</button>
      </div>

      <StatsPanel stats={stats} />

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
        <div style={{
          border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, backgroundColor: "#fafafa", maxHeight: 500, overflowY: "auto",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", marginBottom: 8 }}>
            Sessions
            {!selectedSession ? null : (
              <span
                onClick={() => setSelectedSession(null)}
                style={{ marginLeft: 8, color: "#4f46e5", cursor: "pointer", textTransform: "none", fontWeight: 400 }}
              >(show all)</span>
            )}
          </div>
          {sessions.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9ca3af", padding: 16, textAlign: "center" }}>
              No sessions yet. Serve a model to see events.
            </div>
          ) : sessions.map((s) => (
            <SessionCard
              key={s.session_id}
              session={s}
              selected={selectedSession === s.session_id}
              onSelect={setSelectedSession}
            />
          ))}
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, backgroundColor: "#fff", maxHeight: 500, overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", marginBottom: 8 }}>
            {selectedSession ? "Session Events" : "Live Events"}
          </div>
          {events.length === 0 ? (
            <div style={{ fontSize: 12, color: "#9ca3af", padding: 16, textAlign: "center" }}>
              Waiting for events...
            </div>
          ) : events.slice(0, 200).map((e) => (
            <EventRow key={e.event_id} event={e} />
          ))}
        </div>
      </div>
    </div>
  )
}
