import { useState } from "react"
import { useBenchmarks } from "../hooks"
import type { BenchmarkRecord } from "../types"

function formatMs(ms?: number): string {
  if (ms === undefined || ms === null) return "—"
  return `${ms.toFixed(1)} ms`
}

function formatTps(tps?: number): string {
  if (tps === undefined || tps === null) return "—"
  return `${tps.toFixed(1)} tok/s`
}

export default function BenchmarkPanel() {
  const [selectedSuite, setSelectedSuite] = useState<string>("all")
  const { benchmarks, loading, refetch } = useBenchmarks()

  const suites = ["all", ...new Set(benchmarks.map((b) => b.suite))]
  const filtered = selectedSuite === "all" ? benchmarks : benchmarks.filter((b) => b.suite === selectedSuite)

  // Calculate top-line metrics
  const validCompletionTps = benchmarks.map((b) => b.completion_tps).filter((v): v is number => v !== undefined && v > 0)
  const validPromptTps = benchmarks.map((b) => b.prompt_tps).filter((v): v is number => v !== undefined && v > 0)
  const validTtft = benchmarks.map((b) => b.ttft_ms).filter((v): v is number => v !== undefined && v > 0)

  const maxCompletionTps = validCompletionTps.length ? Math.max(...validCompletionTps) : 0
  const maxPromptTps = validPromptTps.length ? Math.max(...validPromptTps) : 0
  const minTtft = validTtft.length ? Math.min(...validTtft) : 0

  return (
    <div>
      {/* Top Stat Cards */}
      <div style={{ display: "flex", gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "Top Decode Speed", value: maxCompletionTps ? `${maxCompletionTps.toFixed(1)} tok/s` : "—", sub: "Max Completion TPS", color: "#10b981" },
          { label: "Top Prefill Speed", value: maxPromptTps ? `${maxPromptTps.toFixed(1)} tok/s` : "—", sub: "Max Prompt TPS", color: "#3b82f6" },
          { label: "Lowest TTFT", value: minTtft ? `${minTtft.toFixed(1)} ms` : "—", sub: "Time to First Token", color: "#8b5cf6" },
          { label: "Total Runs", value: String(benchmarks.length), sub: `${new Set(benchmarks.map(b => b.suite)).size} active suites`, color: "#4f46e5" },
        ].map((s) => (
          <div key={s.label} style={{
            padding: "16px 22px", borderRadius: 10, border: "1px solid #e5e7eb", backgroundColor: "#fff", flex: 1, minWidth: 160,
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          }}>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: s.color, marginTop: 4 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Suite Filter Bar & Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#4b5563" }}>Suite:</span>
          {suites.map((s) => (
            <button
              key={s}
              onClick={() => setSelectedSuite(s)}
              style={{
                padding: "6px 14px",
                fontSize: 12,
                borderRadius: 20,
                border: "1px solid",
                borderColor: selectedSuite === s ? "#4f46e5" : "#e5e7eb",
                backgroundColor: selectedSuite === s ? "#eef2ff" : "#fff",
                color: selectedSuite === s ? "#4f46e5" : "#6b7280",
                fontWeight: selectedSuite === s ? 600 : 400,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {s === "all" ? "All Suites" : s}
            </button>
          ))}
        </div>
        <button
          onClick={refetch}
          style={{
            padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "1px solid #d1d5db",
            backgroundColor: "#fff", color: "#374151", cursor: "pointer", fontWeight: 500,
          }}
        >
          Refresh Data
        </button>
      </div>

      {/* Benchmarks Table */}
      {loading && benchmarks.length === 0 ? (
        <div style={{ textAlign: "center", padding: 48, color: "#9ca3af" }}>Loading benchmark runs...</div>
      ) : filtered.length === 0 ? (
        <div style={{
          textAlign: "center", padding: 48, backgroundColor: "#f9fafb", borderRadius: 8, border: "1px dashed #d1d5db",
          color: "#6b7280",
        }}>
          <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>No benchmarks recorded yet.</p>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "#9ca3af" }}>
            Run the benchmark runner script to populate this dashboard with inference metrics.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8, backgroundColor: "#fff" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13 }}>
            <thead>
              <tr style={{ backgroundColor: "#f9fafb", borderBottom: "1px solid #e5e7eb", color: "#4b5563" }}>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Test Label / Configuration</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Suite</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Model</th>
                <th style={{ padding: "12px 16px", fontWeight: 600, textAlign: "right" }}>TTFT</th>
                <th style={{ padding: "12px 16px", fontWeight: 600, textAlign: "right" }}>Prompt TPS</th>
                <th style={{ padding: "12px 16px", fontWeight: 600, textAlign: "right" }}>Completion TPS</th>
                <th style={{ padding: "12px 16px", fontWeight: 600, textAlign: "right" }}>Total Latency</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Tokens (In / Out)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => (
                <tr key={b.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ fontWeight: 600, color: "#111827" }}>{b.label}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                      {Object.entries(b.config).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <span style={{
                      fontSize: 11, padding: "2px 8px", borderRadius: 4, fontWeight: 500,
                      backgroundColor: "#e0e7ff", color: "#3730a3",
                    }}>{b.suite}</span>
                  </td>
                  <td style={{ padding: "12px 16px", color: "#4b5563", fontSize: 12 }}>
                    {b.model_name}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600, color: "#8b5cf6" }}>
                    {formatMs(b.ttft_ms)}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontWeight: 600, color: "#3b82f6" }}>
                    {formatTps(b.prompt_tps)}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontWeight: 700, color: "#10b981" }}>
                    {formatTps(b.completion_tps)}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", color: "#6b7280" }}>
                    {formatMs(b.total_ms)}
                  </td>
                  <td style={{ padding: "12px 16px", color: "#6b7280", fontSize: 12 }}>
                    {b.prompt_tokens ?? "?"} / {b.output_tokens ?? "?"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
