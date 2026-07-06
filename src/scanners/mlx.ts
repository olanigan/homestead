import { readdirSync, statSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelRecord } from "../types.js"

export async function scanMlx(): Promise<ModelRecord[]> {
  const hubDir = join(homedir(), ".cache", "huggingface", "hub")
  const models: ModelRecord[] = []
  const now = new Date().toISOString()

  if (!existsSync(hubDir)) return models

  const entries = readdirSync(hubDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirName = entry.name
    const match = dirName.match(/^models--mlx-community--(.+)$/)
    if (!match) continue

    const modelDir = join(hubDir, dirName)
    const snapshotsDir = join(modelDir, "snapshots")
    if (!existsSync(snapshotsDir)) continue

    const snapshots = readdirSync(snapshotsDir).filter((f) => f !== ".no_exist")
    let totalBytes = 0

    for (const snap of snapshots) {
      const snapPath = join(snapshotsDir, snap)
      const entries2 = readdirSync(snapPath, { withFileTypes: true })
      for (const file of entries2) {
        if (file.name.startsWith(".")) continue
        const fullPath = join(snapPath, file.name)
        try {
          if (file.isFile() || file.isSymbolicLink()) {
            const s = statSync(fullPath)
            totalBytes += s.size
          }
        } catch { /* skip inaccessible */ }
      }
    }

    models.push({
      id: `mlx-${match[1]!.toLowerCase()}`,
      name: `mlx-community/${match[1]!}`,
      source: "mlx",
      sourceId: `huggingface/mlx-community/${match[1]!}`,
      path: modelDir,
      sizeBytes: totalBytes,
      format: "mlx",
      quantization: null,
      engine: "mlx",
      status: "discovered",
      metadata: { org: "mlx-community", modelName: match[1]!, tags: ["weights"] },
      discoveredAt: now,
      updatedAt: now,
    })
  }

  return models
}
