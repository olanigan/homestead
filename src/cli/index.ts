import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { Command } from "commander"
import type { ModelSource, ModelRecord, ServingProcess } from "../types.js"
import { Registry } from "../core/registry.js"
import { discoverAll } from "../core/scanner.js"
import { engineManager } from "../engines/index.js"
interface ListOptions {
  source?: ModelSource
  format?: string
  tag?: string
  json?: boolean
}

export function registerCli(program: Command): void {


  const registry = new Registry()
  const logger = console

  program
    .name("homestead")
    .description("Your Local AI Harness")
    .version("0.0.2", "-v, --version", "Output the current version")
    .showHelpAfterError()

  program
    .command("version")
    .description("Show the version of Homestead")
    .action(() => {
      logger.log("0.0.2")
    })

  program
    .command("discover")
    .description("Scan all model sources and update the registry")
    .option("--json", "Emit JSON")
    .action(async (opts: { json?: boolean }) => {
      const result = await discoverAll(registry)
      if (opts.json) {
        logger.log(JSON.stringify(result, null, 2))
        return
      }
      logger.log("\n  Discovery complete")
      for (const s of result.discover.scanned) {
        logger.log(`  ${s}`)
      }
      logger.log(`\n  Total models in registry: ${result.models.length}`)
      logger.log(`  New models: ${result.discover.newModels}`)
      logger.log(`  Time: ${result.discover.elapsedMs}ms`)
      if (result.discover.failedScanners.length > 0) {
        logger.log(`  Failed scanners:`)
        for (const f of result.discover.failedScanners) {
          logger.log(`    ${f.name}: ${f.error}`)
        }
      }
    })

  program
    .command("list")
    .description("List all models in the registry")
    .option("--source <source>", "Filter by source (ollama, hf-hub, gguf-file, mlx)")
    .option("--format <format>", "Filter by format (gguf, safetensors, mlx)")
    .option("--tag <tag>", "Filter by tag (weights, vocab, cloud, incomplete, unknown)")
    .option("--json", "Emit JSON")
    .action(async (opts: ListOptions) => {
      let models = registry.list(opts.source)
      if (opts.format) {
        models = models.filter((m) => m.format === opts.format)
      }
      if (opts.tag) {
        const tag = opts.tag.toLowerCase()
        models = models.filter((m) => {
          const tags = (m.metadata?.tags as string[]) || []
          return tags.includes(tag)
        })
      }
      if (opts.json) {
        logger.log(JSON.stringify(models, null, 2))
        return
      }
      if (models.length === 0) {
        logger.log("No models found. Run `homestead discover` first.")
        return
      }
      const stats = registry.stats()
      logger.log(`\n  Registry: ${stats.totalModels} models (${formatBytes(stats.totalSizeBytes)})`)
      logger.log(`  Serving: ${stats.servingCount}  |  Incomplete: ${stats.incompleteCount}`)
      logger.log(`\n  ${"MODEL".padEnd(44)} ${"SOURCE".padEnd(12)} ${"FORMAT".padEnd(12)} ${"SIZE".padEnd(9)} ${"TAGS".padEnd(12)} ${"STATUS"}`)
      logger.log(`  ${"─".repeat(44)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(9)} ${"─".repeat(12)} ${"─".repeat(10)}`)
      for (const m of models) {
        const name = m.name.length > 42 ? m.name.slice(0, 39) + "..." : m.name
        const tags = ((m.metadata?.tags as string[]) || []).join(",")
        logger.log(`  ${name.padEnd(44)} ${m.source.padEnd(12)} ${m.format.padEnd(12)} ${formatBytes(m.sizeBytes).padEnd(9)} ${tags.padEnd(12)} ${m.status}`)
      }
    })

  program
    .command("inspect")
    .description("Show detailed metadata for a model")
    .argument("<name>", "Model name or ID")
    .option("--json", "Emit JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const model = registry.get(name)
      if (!model) {
        logger.error(`Model not found: ${name}`)
        process.exit(1)
      }
      if (opts.json) {
        logger.log(JSON.stringify(model, null, 2))
        return
      }
      const tags = ((model.metadata?.tags as string[]) || []).join(", ")
      logger.log(`\n  ${model.name}`)
      logger.log(`  ${"─".repeat(Math.min(model.name.length, 50))}`)
      logger.log(`  ID:       ${model.id}`)
      logger.log(`  Source:   ${model.source}`)
      logger.log(`  Format:   ${model.format}`)
      logger.log(`  Size:     ${formatBytes(model.sizeBytes)}`)
      logger.log(`  Tags:     ${tags || "(none)"}`)
      logger.log(`  Status:   ${model.status}`)
      logger.log(`  Engine:   ${model.engine || "auto-detect"}`)
      if (model.quantization) logger.log(`  Quant:    ${model.quantization}`)
      logger.log(`  Path:     ${model.path}`)
      logger.log(`  Found:    ${model.discoveredAt}`)
    })

  program
    .command("serve")
    .description("Start serving a model")
    .argument("<name>", "Model name or ID")
    .option("-p, --port <port>", "Port to serve on", "8080")
    .action(async (name: string, opts: { port: string }) => {
      let model = registry.get(name)
      if (!model) {
        if (existsSync(name)) {
          const stat = statSync(name)
          const fileName = name.split("/").pop()?.replace(/\.\w+$/, "") || "model"
          const isGguf = name.endsWith(".gguf")
          model = {
            id: `inline-${fileName.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-")}`,
            name: fileName,
            source: "imported",
            sourceId: resolve(name),
            path: resolve(name),
            sizeBytes: stat.size,
            format: isGguf ? "gguf" : "unknown",
            quantization: null,
            engine: isGguf ? "llama.cpp" : null,
            status: "discovered",
            metadata: { tags: isGguf ? ["weights"] : ["unknown"] },
            discoveredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        } else {
          logger.error(`Model not found: ${name}. Provide a valid model name or file path.`)
          process.exit(1)
        }
      }
      const tags = (model.metadata?.tags as string[]) || []
      if (tags.includes("vocab")) {
        logger.error(`Cannot serve model "${name}": this is a vocabulary-only file, not a model with weights`)
        process.exit(1)
      }
      if (tags.includes("cloud")) {
        logger.error(`Cannot serve model "${name}": this is a cloud-only model, not available locally`)
        process.exit(1)
      }
      if (tags.includes("incomplete")) {
        logger.error(`Cannot serve model "${name}": download is incomplete (missing files)`)
        process.exit(1)
      }

      const engine = engineManager.selectEngine(model)
      if (!engine) {
        logger.error(`No engine available for model ${name} (format: ${model.format})`)
        process.exit(1)
      }
      logger.log(`Starting ${model.name} via ${engine.name} on port ${opts.port}...`)
      try {
        const proc = await engine.serve(model, parseInt(opts.port))
        registry.updateStatus(model.id, "serving")
        logger.log(`  Serving at ${proc.endpoint}`)
        logger.log(`  PID: ${proc.pid}`)
      } catch (err) {
        logger.error(`Failed to serve model: ${err}`)
        process.exit(1)
      }
    })

  program
    .command("stop")
    .description("Stop a running model server")
    .argument("<name>", "Model name or ID")
    .action(async (name: string) => {
      const model = registry.get(name)
      if (!model) {
        logger.error(`Model not found: ${name}`)
        process.exit(1)
      }
      const engine = engineManager.selectEngine(model)
      if (!engine) {
        logger.error(`No engine found for model ${name}`)
        process.exit(1)
      }
      const processes = engineManager.getRunningProcesses().filter((p) => p.modelId === model.id)
      if (processes.length === 0) {
        const syntheticProc: ServingProcess = {
          modelId: model.id,
          engineKind: engine.kind,
          pid: 0,
          port: model.metadata?.apiEndpoint
            ? parseInt(new URL(model.metadata.apiEndpoint as string).port) || 11434
            : model.engine === "ollama" ? 11434 : 8080,
          endpoint: model.path,
          startedAt: new Date().toISOString(),
        }
        await engine.stop(syntheticProc)
        registry.updateStatus(model.id, "stopped")
        logger.log(`Stopped ${name}`)
        return
      }
      for (const proc of processes) {
        await engine.stop(proc)
      }
      registry.updateStatus(model.id, "stopped")
      logger.log(`Stopped ${name}`)
    })

  program
    .command("status")
    .description("Show running engines and serving models")
    .option("--json", "Emit JSON")
    .action(async (opts: { json?: boolean }) => {
      const statuses = await engineManager.allStatuses()
      const processes = engineManager.getRunningProcesses()
      if (opts.json) {
        logger.log(JSON.stringify({ engines: statuses, processes }, null, 2))
        return
      }
      logger.log("\n  Engines")
      logger.log(`  ${"─".repeat(40)}`)
      for (const s of statuses) {
        const icon = s.healthy ? "\u25CF" : "\u25CB"
        logger.log(`  ${icon} ${s.kind}${s.running ? ` (port ${s.port})` : ""}`)
      }
      logger.log(`\n  Active Servers`)
      logger.log(`  ${"─".repeat(40)}`)
      if (processes.length === 0) {
        logger.log("  (none)")
      } else {
        for (const p of processes) {
          logger.log(`  ${p.modelId} \u2192 ${p.endpoint} (pid ${p.pid})`)
        }
      }
    })

  program
    .command("pull")
    .description("Download a model from HuggingFace, Ollama, or URL")
    .argument("<uri>", "Model URI (hf://org/model, ollama://model, or http URL)")
    .action(async (uri: string) => {
      if (uri.startsWith("ollama://")) {
        const modelName = uri.replace("ollama://", "")
        logger.log(`Pulling ${modelName} from Ollama...`)
        const { spawn } = await import("node:child_process")
        const proc = spawn("ollama", ["pull", modelName], { stdio: "inherit" })
        await new Promise<void>((resolve, reject) => {
          proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ollama pull exited ${code}`)))
          proc.on("error", reject)
        })
        logger.log("Done. Run `homestead discover` to register.")
      } else if (uri.startsWith("hf://")) {
        const repo = uri.replace("hf://", "")
        logger.log(`Pulling ${repo} from HuggingFace...`)
        const { spawn } = await import("node:child_process")
        const proc = spawn("huggingface-cli", ["download", repo, "--resume-download"], {
          stdio: "inherit",
          env: { ...process.env, HF_HUB_ENABLE_HF_TRANSFER: "1" },
        })
        await new Promise<void>((resolve, reject) => {
          proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`huggingface-cli exited ${code}`)))
          proc.on("error", reject)
        })
        logger.log("Done. Run `homestead discover` to register.")
      } else if (uri.startsWith("http")) {
        logger.log(`Downloading from ${uri}...`)
        const filename = uri.split("/").pop() || "model.gguf"
        const { spawn } = await import("node:child_process")
        const proc = spawn("curl", ["-L", "-o", filename, uri], { stdio: "inherit" })
        await new Promise<void>((resolve, reject) => {
          proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`curl exited ${code}`)))
          proc.on("error", reject)
        })
        logger.log(`Downloaded to ${filename}. Run 'homestead import ${filename}' to register.`)
      } else {
        logger.error(`Unknown URI scheme: ${uri}. Use hf://, ollama://, or http(s)://`)
        process.exit(1)
      }
    })

  program
    .command("import")
    .description("Import a local model file into the registry")
    .argument("<path>", "Path to model file (GGUF, safetensors, etc.)")
    .action(async (filepath: string) => {
      const { existsSync, statSync } = await import("node:fs")
      if (!existsSync(filepath)) {
        logger.error(`File not found: ${filepath}`)
        process.exit(1)
      }
      const stat = statSync(filepath)
      const name = filepath.split("/").pop()?.replace(/\.\w+$/, "") || "imported-model"
      const isGguf = filepath.endsWith(".gguf")
      const now = new Date().toISOString()

      const tags: string[] = isGguf ? ["weights"] : ["unknown"]

      const model: ModelRecord = {
        id: `imported-${name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`,
        name,
        source: "imported",
        sourceId: filepath,
        path: filepath,
        sizeBytes: stat.size,
        format: isGguf ? "gguf" : "unknown",
        quantization: null,
        engine: isGguf ? "llama.cpp" : null,
        status: "discovered",
        metadata: { filepath, importedAt: now, tags },
        discoveredAt: now,
        updatedAt: now,
      }
      registry.upsert(model)
      logger.log(`Imported ${name} (${formatBytes(stat.size)})`)
    })

  program
    .command("obs")
    .description("Show observability stats for model serving")
    .option("--json", "Emit JSON")
    .action(async (opts: { json?: boolean }) => {
      const { globalEmitter } = await import("../observability/emitter.js")
      const db = globalEmitter.getDb()
      const stats = db.stats()
      const sessions = db.getSessions(10)
      if (opts.json) {
        logger.log(JSON.stringify({ stats, sessions }, null, 2))
        return
      }
      logger.log(`\n  Observability`)
      logger.log(`  ${"─".repeat(40)}`)
      logger.log(`  Sessions:  ${stats.total_sessions} (${stats.active_sessions} active)`)
      logger.log(`  Events:    ${stats.total_events}`)
      logger.log(`  Requests:  ${stats.total_requests}`)
      logger.log(`  Errors:    ${stats.total_errors}`)
      logger.log(`\n  Recent Sessions`)
      logger.log(`  ${"─".repeat(60)}`)
      for (const s of sessions) {
        const name = s.model_name.length > 36 ? s.model_name.slice(0, 33) + "..." : s.model_name
        logger.log(`  ${s.status === "active" ? "\u25CF" : "\u25CB"} ${name.padEnd(36)} ${s.engine_kind.padEnd(10)} ${s.event_count} events`)
      }
    })

  program
    .command("ui")
    .description("Launch the web dashboard")
    .option("-p, --port <port>", "Port for the UI server", "3030")
    .action(async (opts: { port: string }) => {
      logger.log(`Starting web dashboard on http://localhost:${opts.port}...`)
      const { serveUi } = await import("../ui/server.js")
      await serveUi(parseInt(opts.port), registry)
    })
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
