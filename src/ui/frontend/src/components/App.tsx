import { useState } from "react"
import { useModels, useStatus, useDiscover } from "../hooks"
import type { ModelRecord } from "../types"
import ObservabilityPanel from "./ObservabilityPanel.js"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function getTags(model: ModelRecord): string[] {
  return (model.metadata?.tags as string[]) || []
}

function tagColor(tag: string): string {
  const colors: Record<string, string> = {
    weights: "#10b981",
    vocab: "#9ca3af",
    cloud: "#3b82f6",
    incomplete: "#f59e0b",
    unknown: "#6b7280",
  }
  return colors[tag] || "#6b7280"
}

function sourceColor(source: string): string {
  const colors: Record<string, string> = {
    ollama: "#4f46e5",
    "hf-hub": "#f59e0b",
    mlx: "#06b6d4",
    "gguf-file": "#8b5cf6",
    imported: "#10b981",
    "engine-probe": "#6b7280",
  }
  return colors[source] || "#6b7280"
}

function statusDot(status: string): string {
  switch (status) {
    case "serving": return "🟢"
    case "discovered": return "🔵"
    case "incomplete": return "🟡"
    case "stopped": return "⚪"
    case "error": return "🔴"
    default: return "⚪"
  }
}

function ModelCard({ model }: { model: ModelRecord }) {
  const api = ""
  const tags = getTags(model)
  const isNonServing = tags.includes("vocab") || tags.includes("cloud") || tags.includes("incomplete")
  const dimOpacity = isNonServing ? 0.55 : 1

  const handleServe = async () => {
    if (isNonServing) return
    await fetch(`${api}/api/models/${model.id}/serve`, { method: "POST" })
    window.location.reload()
  }
  const handleStop = async () => {
    await fetch(`${api}/api/models/${model.id}/stop`, { method: "POST" })
    window.location.reload()
  }

  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: 16,
      backgroundColor: "#fff",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      opacity: dimOpacity,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{model.name}</span>
        <span style={{ fontSize: 12 }}>{statusDot(model.status)} {model.status}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 11,
          padding: "2px 6px",
          borderRadius: 4,
          backgroundColor: sourceColor(model.source) + "20",
          color: sourceColor(model.source),
          fontWeight: 500,
        }}>{model.source}</span>
        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, backgroundColor: "#f3f4f6" }}>{model.format}</span>
        {model.quantization && (
          <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, backgroundColor: "#f3f4f6" }}>{model.quantization}</span>
        )}
        {tags.map((t) => (
          <span key={t} style={{
            fontSize: 11, padding: "2px 6px", borderRadius: 4,
            backgroundColor: tagColor(t) + "20", color: tagColor(t), fontWeight: 500,
          }}>{t}</span>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "#6b7280" }}>{formatBytes(model.sizeBytes)}</div>
      <div style={{ fontSize: 12, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.path}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        {model.engine && model.status !== "serving" && !isNonServing && (
          <button onClick={handleServe} style={{
            padding: "4px 12px", fontSize: 12, borderRadius: 4, border: "none",
            backgroundColor: "#10b981", color: "#fff", cursor: "pointer",
          }}>Serve</button>
        )}
        {model.status === "serving" && (
          <button onClick={handleStop} style={{
            padding: "4px 12px", fontSize: 12, borderRadius: 4, border: "none",
            backgroundColor: "#ef4444", color: "#fff", cursor: "pointer",
          }}>Stop</button>
        )}
      </div>
    </div>
  )
}

function ModelGrid({ models }: { models: ModelRecord[] }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      gap: 16,
    }}>
      {models.map((m) => <ModelCard key={m.id} model={m} />)}
    </div>
  )
}

function FilterBar({ label, items, selected, onSelect }: { label: string; items: string[]; selected: string | null; onSelect: (s: string | null) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "#6b7280", marginRight: 4 }}>{label}:</span>
      <button onClick={() => onSelect(null)} style={{
        padding: "4px 12px", fontSize: 12, borderRadius: 16, border: "1px solid #d1d5db",
        backgroundColor: selected === null ? "#4f46e5" : "#fff",
        color: selected === null ? "#fff" : "#374151", cursor: "pointer",
      }}>All</button>
      {items.map((s) => (
        <button key={s} onClick={() => onSelect(s)} style={{
          padding: "4px 12px", fontSize: 12, borderRadius: 16, border: "1px solid #d1d5db",
          backgroundColor: selected === s ? "#4f46e5" : "#fff",
          color: selected === s ? "#fff" : "#374151", cursor: "pointer",
        }}>{s}</button>
      ))}
    </div>
  )
}

function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      placeholder="Search models..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db",
        width: "100%", maxWidth: 400, fontSize: 14, marginBottom: 16, boxSizing: "border-box",
      }}
    />
  )
}

function StatsBar({ total, size }: { total: number; size: string }) {
  return (
    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
      {total} models · {size} total
    </div>
  )
}

function EngineStatus({ data }: { data: { engines: Array<{ kind: string; healthy: boolean; port: number | null }> } | null }) {
  if (!data) return null
  return (
    <div style={{ display: "flex", gap: 16, marginBottom: 24, padding: 16, backgroundColor: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
      {data.engines.map((e) => (
        <div key={e.kind} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <span style={{ color: e.healthy ? "#10b981" : "#9ca3af" }}>{e.healthy ? "●" : "○"}</span>
          <span style={{ fontWeight: 500 }}>{e.kind}</span>
          {e.healthy && e.port && <span style={{ color: "#6b7280" }}>(:{e.port})</span>}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const { models, loading, refetch } = useModels()
  const { data: statusData } = useStatus()
  const { discover, scanning } = useDiscover()
  const [filterSource, setFilterSource] = useState<string | null>(null)
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState<"models" | "obs">("models")

  const sources = [...new Set(models.map((m) => m.source))].sort()
  const allTags = [...new Set(models.flatMap((m) => getTags(m)))].sort()
  let filtered = filterSource ? models.filter((m) => m.source === filterSource) : models
  if (filterTag) {
    filtered = filtered.filter((m) => getTags(m).includes(filterTag))
  }
  if (search) {
    const q = search.toLowerCase()
    filtered = filtered.filter((m) => m.name.toLowerCase().includes(q) || m.format.toLowerCase().includes(q))
  }
  const totalBytes = filtered.reduce((s, m) => s + m.sizeBytes, 0)

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
          <span style={{ color: "#4f46e5" }}>homestead</span> — Local AI Harness
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={async () => { await discover(); refetch() }} disabled={scanning} style={{
            padding: "8px 16px", fontSize: 13, borderRadius: 6, border: "none",
            backgroundColor: scanning ? "#9ca3af" : "#4f46e5", color: "#fff", cursor: scanning ? "not-allowed" : "pointer",
          }}>{scanning ? "Scanning..." : "Discover"}</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: "2px solid #e5e7eb" }}>
        <button onClick={() => setTab("models")} style={{
          padding: "8px 20px", fontSize: 14, fontWeight: 500, border: "none", cursor: "pointer",
          backgroundColor: "transparent", color: tab === "models" ? "#4f46e5" : "#6b7280",
          borderBottom: tab === "models" ? "2px solid #4f46e5" : "2px solid transparent",
          marginBottom: -2,
        }}>Models</button>
        <button onClick={() => setTab("obs")} style={{
          padding: "8px 20px", fontSize: 14, fontWeight: 500, border: "none", cursor: "pointer",
          backgroundColor: "transparent", color: tab === "obs" ? "#4f46e5" : "#6b7280",
          borderBottom: tab === "obs" ? "2px solid #4f46e5" : "2px solid transparent",
          marginBottom: -2,
        }}>Observability</button>
      </div>

      {tab === "models" ? (
        <>
          <EngineStatus data={statusData} />
          <FilterBar label="Source" items={sources} selected={filterSource} onSelect={setFilterSource} />
          <FilterBar label="Tag" items={allTags} selected={filterTag} onSelect={setFilterTag} />
          <SearchBar value={search} onChange={setSearch} />
          <StatsBar total={filtered.length} size={formatBytes(totalBytes)} />

          {loading ? (
            <div style={{ textAlign: "center", color: "#9ca3af", padding: 48 }}>Loading models...</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9ca3af", padding: 48 }}>
              No models found. Run <code style={{ backgroundColor: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>homestead discover</code> first.
            </div>
          ) : (
            <ModelGrid models={filtered} />
          )}
        </>
      ) : (
        <ObservabilityPanel />
      )}
    </div>
  )
}
