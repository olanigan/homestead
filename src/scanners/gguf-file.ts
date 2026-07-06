import { readdirSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelRecord } from "../types.js"
import { readGgufHeader } from "../core/gguf.js"

interface SearchPath {
  path: string
  source: ModelRecord["source"]
  glob: string
}

const searchPaths: SearchPath[] = [
  { path: join(homedir(), ".unsloth"), source: "gguf-file", glob: "*.gguf" },
  { path: join(homedir(), ".ollama", "models", ".studio_links"), source: "ollama", glob: "*.gguf" },
  { path: join(homedir(), "models"), source: "gguf-file", glob: "*.gguf" },
  { path: join(homedir(), ".lmstudio", "models"), source: "gguf-file", glob: "*.gguf" },
  { path: "/usr/local/models", source: "gguf-file", glob: "*.gguf" },
]

function findGgufFiles(dir: string, maxDepth = 3): string[] {
  if (!existsSync(dir)) return []
  try {
    const results: string[] = []
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory() && maxDepth > 0) {
        results.push(...findGgufFiles(fullPath, maxDepth - 1))
      } else if (entry.isFile() && entry.name.endsWith(".gguf")) {
        results.push(fullPath)
      }
    }
    return results
  } catch {
    return []
  }
}

function detectQuantFromPath(filepath: string): string | null {
  const match = filepath.match(/Q\d+_\w+|q\d+_\w+|fp16|f16|fp32|f32|BF16|bf16/i)
  return match ? match[0].toUpperCase() : null
}

function nameFromPath(filepath: string): string {
  const basename = filepath.split("/").pop() || "unknown"
  return basename.replace(/\.gguf$/i, "")
}

export async function scanGgufFiles(): Promise<ModelRecord[]> {
  const models: ModelRecord[] = []
  const seen = new Set<string>()
  const now = new Date().toISOString()

  for (const sp of searchPaths) {
    const files = findGgufFiles(sp.path)
    for (const filepath of files) {
      if (seen.has(filepath)) continue
      seen.add(filepath)
      let stat: { size: number }
      try {
        const s = statSync(filepath)
        stat = { size: s.size }
      } catch {
        stat = { size: 0 }
      }

      const name = nameFromPath(filepath)
      if (name.toLowerCase().startsWith("mmproj-") || name.toLowerCase().startsWith("tokenizer-")) continue

      const id = `gguf-${name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`
      const header = readGgufHeader(filepath)
      const isVocab = header !== null && header.tensorCount === 0
      if (isVocab) continue

      const tags: string[] = ["weights"]

      models.push({
        id,
        name,
        source: "gguf-file",
        sourceId: filepath,
        path: filepath,
        sizeBytes: stat.size,
        format: "gguf",
        quantization: detectQuantFromPath(filepath),
        engine: "llama.cpp",
        status: "discovered",
        metadata: { filepath, searchSource: sp.source, tags },
        discoveredAt: now,
        updatedAt: now,
      })
    }
  }

  return models
}
