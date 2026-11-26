import { useState } from "react"
import { useBenchmarks, useModels } from "../hooks"
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
  const { models } = useModels()

  // Runner state
  const [targetModelId, setTargetModelId] = useState<string>("")
  const [runs, setRuns] = useState<number>(2)
  const [maxTokens, setMaxTokens] = useState<number>(64)
  const [threads, setThreads] = useState<number>(4)
  const [batchSize, setBatchSize] = useState<number>(512)
  const [flashAttn, setFlashAttn] = useState<boolean>(true)
  const [running, setRunning] = useState<boolean>(false)
  const [lastResult, setLastResult] = useState<{ ttft: number; promptTps: number; completionTps: number; modelName: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const servableModels = models.filter((m) => {
    const tags = (m.metadata?.tags as string[]) || []
    return !tags.includes("vocab") && !tags.includes("cloud") && !tags.includes("incomplete") && m.engine
  })

  const suites = ["all", ...new Set(benchmarks.map((b) => b.suite))]
  const filtered = selectedSuite === "all" ? benchmarks : benchmarks.filter((b) => b.suite === selectedSuite)

  // Calculate top-line metrics
  const validCompletionTps = benchmarks.map((b) => b.completion_tps).filter((v): v is number => v !== undefined && v > 0)
  const validPromptTps = benchmarks.map((b) => b.prompt_tps).filter((v): v is number => v !== undefined && v > 0)
  const validTtft = benchmarks.map((b) => b.ttft_ms).filter((v): v is number => v !== undefined && v > 0)

  const maxCompletionTps = validCompletionTps.length ? Math.max(...validCompletionTps) : 0
  const maxPromptTps = validPromptTps.length ? Math.max(...validPromptTps) : 0
  const minTtft = validTtft.length ? Math.min(...validTtft) : 0

  const handleRunBenchmark = async () => {
    const modelId = targetModelId || servableModels[0]?.id
    if (!modelId) {
      setErrorMsg("Please select a servable model.")
      return
    }

    setRunning(true)
    setErrorMsg(null)
    setLastResult(null)

    try {
      const res = await fetch(`/api/models/${modelId}/bench`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runs,
          maxTokens,
          threads,
          batchSize,
          ubatchSize: Math.floor(batchSize / 2),
          flashAttn,
          suite: "UI Studio Sweeps",
          label: `${threads} Threads, Batch ${batchSize}${flashAttn ? ", FlashAttn" : ""}`,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      const selModel = servableModels.find((m) => m.id === modelId)
      setLastResult({
        ttft: data.avgTtft,
        promptTps: data.avgPromptTps,
        completionTps: data.avgCompletionTps,
        modelName: selModel?.name || modelId,
      })
      refetch()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleServeWithConfig = async (modelId: string, config: Record<string, unknown>) => {
    try {
      await fetch(`/api/models/${modelId}/serve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
      alert(`Model is now serving with benchmarked configuration!`)
    } catch (err) {
      alert(`Failed to serve model: ${err}`)
    }
  }

  return (
    <div>
      {/* Top Stat Cards */}
      <div style={{ display: "flex", gap: 20, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "Top Decode Speed", value: maxCompletionTps ? `${maxCompletionTps.toFixed(1)} tok/s` : "—", sub: "Max Completion TPS", color: "#10b981" },
          { label: "Top Prefill Speed", value: maxPromptTps ? `${maxPromptTps.toFixed(1)} tok/s` : "—", sub: "Max Prompt TPS", color: "#3b82f6" },
          { label: "Lowest TTFT", value: minTtft ? `${minTtft.toFixed(1)} ms` : "—", sub: "Time to First Token", color: "#8b5cf6" },
          { label: "Total Runs", value: String(benchmarks.length), sub: `${new Set(benchmarks.map((b) => b.suite)).size} active suites`, color: "#4f46e5" },
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

      {/* Interactive Studio Benchmark Launcher */}
      <div style={{
        padding: 20,
        borderRadius: 10,
        border: "1px solid #e0e7ff",
        backgroundColor: "#f8faff",
        marginBottom: 24,
        boxShadow: "0 1px 4px rgba(79, 70, 229, 0.06)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#1e1b4b" }}>Interactive Benchmark Studio</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 12, backgroundColor: "#e0e7ff", color: "#4338ca", fontWeight: 600 }}>Real-Time Inference</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "2 1 200px" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Select Model:</label>
            <select
              value={targetModelId || (servableModels[0]?.id ?? "")}
              onChange={(e) => setTargetModelId(e.target.value)}
              disabled={running}
              style={{
                width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #d1d5db",
                backgroundColor: "#fff", fontSize: 13,
              }}
            >
              {servableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.format} · {m.quantization || "unquantized"})
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: "1 1 80px" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Threads:</label>
            <input
              type="number"
              min="1"
              max="32"
              value={threads}
              onChange={(e) => setThreads(parseInt(e.target.value, 10) || 4)}
              disabled={running}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
            />
          </div>

          <div style={{ flex: "1 1 80px" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Batch:</label>
            <input
              type="number"
              step="128"
              min="128"
              max="2048"
              value={batchSize}
              onChange={(e) => setBatchSize(parseInt(e.target.value, 10) || 512)}
              disabled={running}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
            />
          </div>

          <div style={{ flex: "1 1 80px" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Tokens:</label>
            <input
              type="number"
              min="16"
              max="512"
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 64)}
              disabled={running}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
            />
          </div>

          <div style={{ flex: "1 1 70px" }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Runs:</label>
            <input
              type="number"
              min="1"
              max="10"
              value={runs}
              onChange={(e) => setRuns(parseInt(e.target.value, 10) || 2)}
              disabled={running}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
            <input
              type="checkbox"
              id="flashAttnCheckbox"
              checked={flashAttn}
              onChange={(e) => setFlashAttn(e.target.checked)}
              disabled={running}
            />
            <label htmlFor="flashAttnCheckbox" style={{ fontSize: 12, fontWeight: 500, color: "#374151", cursor: "pointer" }}>Flash-Attn</label>
          </div>

          <div>
            <button
              onClick={handleRunBenchmark}
              disabled={running || servableModels.length === 0}
              style={{
                padding: "8px 20px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 6,
                border: "none",
                backgroundColor: running ? "#9ca3af" : "#4f46e5",
                color: "#fff",
                cursor: running || servableModels.length === 0 ? "not-allowed" : "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
              }}
            >
              {running ? "Benchmarking..." : "⚡ Run Benchmark"}
            </button>
          </div>
        </div>

        {errorMsg && (
          <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, backgroundColor: "#fef2f2", color: "#b91c1c", fontSize: 12, border: "1px solid #fecaca" }}>
            ✗ Benchmark error: {errorMsg}
          </div>
        )}

        {lastResult && (
          <div style={{
            marginTop: 12, padding: "10px 14px", borderRadius: 6, backgroundColor: "#f0fdf4",
            color: "#166534", fontSize: 13, border: "1px solid #bbf7d0", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap",
          }}>
            <span style={{ fontWeight: 600 }}>✓ Result for {lastResult.modelName}:</span>
            <span>TTFT: <strong>{lastResult.ttft.toFixed(1)} ms</strong></span>
            <span>Prefill: <strong>{lastResult.promptTps.toFixed(1)} tok/s</strong></span>
            <span>Decode: <strong style={{ color: "#15803d", fontSize: 14 }}>⚡ {lastResult.completionTps.toFixed(1)} tok/s</strong></span>
          </div>
        )}
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
            Use the Interactive Benchmark Studio above or run <code>homestead bench &lt;model&gt;</code> in the terminal.
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
                <th style={{ padding: "12px 16px", fontWeight: 600, textAlign: "center" }}>Action</th>
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
                  <td style={{ padding: "12px 16px", textAlign: "center" }}>
                    <button
                      onClick={() => handleServeWithConfig(b.model_id, b.config)}
                      style={{
                        padding: "4px 10px",
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 4,
                        border: "1px solid #10b981",
                        backgroundColor: "#ecfdf5",
                        color: "#065f46",
                        cursor: "pointer",
                      }}
                    >
                      🚀 Serve
                    </button>
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
