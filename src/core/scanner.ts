import { performance } from "node:perf_hooks"
import type { ModelRecord, DiscoverResult, Scanner } from "../types.js"
import { Registry } from "./registry.js"
import { scanOllama } from "../scanners/ollama.js"
import { scanHfHub } from "../scanners/hf-hub.js"
import { scanGgufFiles } from "../scanners/gguf-file.js"
import { scanMlx } from "../scanners/mlx.js"

const scanners: Scanner[] = [
  { name: "Ollama", source: "ollama", priority: 1, scan: scanOllama },
  { name: "HF Hub", source: "hf-hub", priority: 2, scan: scanHfHub },
  { name: "GGUF Files", source: "gguf-file", priority: 3, scan: scanGgufFiles },
  { name: "MLX Models", source: "mlx", priority: 4, scan: scanMlx },
]

export function registerScanner(scanner: Scanner): void {
  scanners.push(scanner)
}

export async function runDiscovery(registry: Registry): Promise<DiscoverResult> {
  const start = performance.now()
  const scanned: string[] = []
  const failedScanners: { name: string; error: string }[] = []
  let totalFound = 0
  let newModels = 0

  for (const scanner of scanners) {
    try {
      const models = await scanner.scan()

      // Clear stale entries before upserting fresh results for this source
      if (models.length > 0) {
        registry.deleteBySource(scanner.source)
        const result = registry.upsertMany(models)
        newModels += result.inserted
      } else {
        const deleted = registry.deleteBySource(scanner.source)
        newModels -= deleted // Track removals in net count
      }
      totalFound += models.length
      scanned.push(`${scanner.name} (${models.length} models)`)
    } catch (err) {
      failedScanners.push({ name: scanner.name, error: String(err) })
      scanned.push(`${scanner.name} (failed)`)
    }
  }

  registry.dedupCrossSource("mlx", "hf-hub")

  const elapsedMs = Math.round(performance.now() - start)
  return { scanned, found: totalFound, newModels, updatedModels: 0, failedScanners, elapsedMs }
}

export async function discoverAll(registry: Registry): Promise<{ discover: DiscoverResult; models: ModelRecord[] }> {
  const discover = await runDiscovery(registry)
  const models = registry.list()
  return { discover, models }
}
