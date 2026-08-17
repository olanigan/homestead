import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { createServer, type AddressInfo } from "node:net"

const CLI_PATH = resolve(import.meta.dir, "../dist/homestead.js")
const PID_DIR = join(homedir(), ".homestead")

const LIQUID_MODEL_PATH = "/Users/unblockd/.cache/huggingface/hub/models--LiquidAI--LFM2.5-230M-GGUF/snapshots/fa224d4cb60cffe61eb58726712ef255bb64d0b7/LFM2.5-230M-Q4_K_M.gguf"
const SMOL_MODEL_PATH = "/Users/unblockd/.cache/huggingface/hub/models--bartowski--SmolLM2-135M-Instruct-GGUF/snapshots/684c2f75c053e272df450a15a5e5d01454642054/SmolLM2-135M-Instruct-Q3_K_M.gguf"

function pidFileFor(modelId: string): string {
  const safe = modelId.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(PID_DIR, `llama-server-${safe}.pid`)
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on("error", rej)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => res(port))
    })
  })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function runCli(args: string[], env: Record<string, string>, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d))
    proc.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`CLI timed out: homestead ${args.join(" ")}`))
    }, timeoutMs)
    proc.on("error", reject)
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function startCli(args: string[], env: Record<string, string>): { proc: ChildProcess; stdout: () => string; stderr: () => string } {
  const proc = spawn(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  proc.stdout.on("data", (d) => (stdout += d))
  proc.stderr.on("data", (d) => (stderr += d))
  return {
    proc,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function waitForHealth(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.status === 200) return true
    } catch {}
    await sleep(500)
  }
  return false
}

async function chat(port: number, prompt: string): Promise<{ text: string; tokens: number; latencyMs: number }> {
  const t0 = Date.now()
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 32,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`Chat error (${res.status}): ${await res.text()}`)
  }
  const data = (await res.json()) as any
  const text = data.choices?.[0]?.message?.content ?? ""
  const tokens = data.usage?.completion_tokens ?? 0
  return { text, tokens, latencyMs: Date.now() - t0 }
}

async function main() {
  console.log("=== Real GGUF Concurrency Test (Liquid LFM2.5 230M & SmolLM2 135M) ===")
  
  if (!existsSync(LIQUID_MODEL_PATH)) {
    throw new Error(`Liquid model not found at ${LIQUID_MODEL_PATH}`)
  }
  if (!existsSync(SMOL_MODEL_PATH)) {
    throw new Error(`SmolLM2 model not found at ${SMOL_MODEL_PATH}`)
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "homestead-real-concurrency-"))
  const env = {
    HOMESTEAD_DB_PATH: join(tmpDir, "models.db"),
    HOMESTEAD_OBS_DB_PATH: join(tmpDir, "obs.db"),
  }

  let serveSmol: { proc: ChildProcess } | null = null
  let serveLiquid: { proc: ChildProcess } | null = null
  let smolId = ""
  let liquidId = ""

  try {
    // 1. Import both models
    console.log("\n1. Importing real GGUF models...")
    const impSmol = await runCli(["import", SMOL_MODEL_PATH], env)
    if (impSmol.code !== 0) throw new Error(`Failed to import SmolLM2: ${impSmol.stderr}`)
    
    const impLiquid = await runCli(["import", LIQUID_MODEL_PATH], env)
    if (impLiquid.code !== 0) throw new Error(`Failed to import Liquid: ${impLiquid.stderr}`)

    const listed = await runCli(["list", "--json"], env)
    const models = JSON.parse(listed.stdout) as Array<{ id: string; name: string; sourceId: string }>
    smolId = models.find((m) => m.sourceId === SMOL_MODEL_PATH)!.id
    liquidId = models.find((m) => m.sourceId === LIQUID_MODEL_PATH)!.id

    console.log(`✓ Imported Model A (SmolLM2-135M): ${smolId}`)
    console.log(`✓ Imported Model B (Liquid-LFM2.5-230M): ${liquidId}`)

    // 2. Start Model A
    const portA = await freePort()
    console.log(`\n2. Starting Model A (SmolLM2) on port ${portA} with real llama.cpp...`)
    serveSmol = startCli(["serve", smolId, "-p", String(portA)], env)
    const smolUp = await waitForHealth(portA)
    if (!smolUp) throw new Error(`SmolLM2 failed to become healthy on port ${portA}`)
    console.log(`✓ Model A healthy at http://127.0.0.1:${portA}/health`)

    // 3. Start Model B (Liquid) concurrently
    const portB = await freePort()
    console.log(`\n3. Starting Model B (Liquid LFM2.5 230M) on port ${portB} with real llama.cpp...`)
    serveLiquid = startCli(["serve", liquidId, "-p", String(portB)], env)
    const liquidUp = await waitForHealth(portB)
    if (!liquidUp) throw new Error(`Liquid LFM failed to become healthy on port ${portB}`)
    console.log(`✓ Model B (Liquid) healthy at http://127.0.0.1:${portB}/health`)

    // 4. Verify Model A is still healthy while Model B is running
    const smolStillUp = await waitForHealth(portA, 5_000)
    if (!smolStillUp) throw new Error(`Model A was killed when Model B started! (Regression detected)`)
    console.log(`✓ Model A confirmed STILL healthy after Model B started`)

    // 5. Send concurrent chat requests to both models
    console.log("\n4. Executing concurrent chat completions against BOTH models...")
    const [resA, resB] = await Promise.all([
      chat(portA, "What is 2 + 2? Reply with just the number."),
      chat(portB, "What is 3 + 3? Reply with just the number."),
    ])

    console.log(`✓ Model A (SmolLM2) Response (${resA.latencyMs}ms, ${resA.tokens} tokens): "${resA.text.trim()}"`)
    console.log(`✓ Model B (Liquid LFM) Response (${resB.latencyMs}ms, ${resB.tokens} tokens): "${resB.text.trim()}"`)

    if (!resA.text.trim()) throw new Error("Model A returned empty response")
    if (!resB.text.trim()) throw new Error("Model B returned empty response")

    // 6. Check status reporting
    console.log("\n5. Checking `homestead status --json`...")
    const statusRes = await runCli(["status", "--json"], env)
    const statusData = JSON.parse(statusRes.stdout) as { processes: Array<{ modelId: string; port: number; pid: number }> }
    console.log("Active processes reported by status:", JSON.stringify(statusData.processes, null, 2))
    
    const procA = statusData.processes.find((p) => p.modelId === smolId)
    const procB = statusData.processes.find((p) => p.modelId === liquidId)

    if (!procA || procA.port !== portA) throw new Error(`Process A not properly reported in status: ${JSON.stringify(procA)}`)
    if (!procB || procB.port !== portB) throw new Error(`Process B not properly reported in status: ${JSON.stringify(procB)}`)
    if (procA.pid === procB.pid) throw new Error(`PIDs collide! Both reported PID ${procA.pid}`)
    console.log(`✓ Distinct PIDs verified: Model A PID=${procA.pid}, Model B PID=${procB.pid}`)

    // 7. Stop Model A and verify Model B (Liquid) survives
    console.log("\n6. Stopping Model A (SmolLM2)...")
    const stopA = await runCli(["stop", smolId], env)
    if (stopA.code !== 0) throw new Error(`Failed to stop Model A: ${stopA.stderr}`)
    console.log(`✓ Stopped Model A`)

    await sleep(1000)
    console.log("Verifying Model B (Liquid) is still alive and serving requests...")
    const liquidAfterAStopped = await chat(portB, "What is the capital of France?")
    console.log(`✓ Model B (Liquid) response after Model A stopped (${liquidAfterAStopped.latencyMs}ms): "${liquidAfterAStopped.text.trim()}"`)

    if (existsSync(pidFileFor(smolId))) throw new Error("Model A PID file still exists after stop")
    if (!existsSync(pidFileFor(liquidId))) throw new Error("Model B PID file was improperly deleted when stopping Model A!")
    console.log(`✓ PID file isolation verified (Model A PID file deleted, Model B PID file intact)`)

    // 8. Stop Model B
    console.log("\n7. Stopping Model B (Liquid)...")
    const stopB = await runCli(["stop", liquidId], env)
    if (stopB.code !== 0) throw new Error(`Failed to stop Model B: ${stopB.stderr}`)
    console.log(`✓ Stopped Model B`)

    await sleep(500)
    if (existsSync(pidFileFor(liquidId))) throw new Error("Model B PID file still exists after stop")
    console.log(`✓ Model B PID file cleanly removed`)

    console.log("\n=======================================================")
    console.log("🎉 ALL REAL CONCURRENCY TESTS PASSED WITH REAL GGUFS!")
    console.log("=======================================================")
  } finally {
    if (serveSmol) serveSmol.proc.kill("SIGKILL")
    if (serveLiquid) serveLiquid.proc.kill("SIGKILL")
    try { await runCli(["stop", smolId], env) } catch {}
    try { await runCli(["stop", liquidId], env) } catch {}
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("❌ Concurrency test failed:", err)
  process.exit(1)
})
