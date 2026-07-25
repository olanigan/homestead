import { listFiles, downloadFileToCacheDir } from "@huggingface/hub"
import type { AccessToken, RepoDesignation } from "@huggingface/hub"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

export interface GgufFile {
  path: string
  size: number
  isMmproj: boolean
}

export async function listGgufFiles(
  repo: string,
  token?: string
): Promise<GgufFile[]> {
  const auth = token ? { accessToken: token as AccessToken } : {}

  const files: GgufFile[] = []
  for await (const entry of listFiles({
    repo: repo as RepoDesignation,
    recursive: true,
    ...auth,
  })) {
    if (entry.type !== "file") continue
    if (!entry.path.endsWith(".gguf")) continue
    files.push({
      path: entry.path,
      size: entry.size,
      isMmproj: entry.path.split("/").pop()?.startsWith("mmproj-") ?? false,
    })
  }
  return files
}

export function autoSelectMmproj(
  selected: GgufFile[],
  all: GgufFile[]
): GgufFile[] {
  const result = [...selected]
  const selectedNames = new Set(selected.map((f) => f.path.split("/").pop()))

  for (const f of selected) {
    if (f.isMmproj) continue
    const baseName = f.path.split("/").pop()
    const mmprojName = `mmproj-${baseName}`
    if (selectedNames.has(mmprojName)) continue
    const match = all.find((a) => a.path.split("/").pop() === mmprojName)
    if (match) {
      result.push(match)
      selectedNames.add(mmprojName)
    }
  }
  return result
}

async function downloadViaJsSdk(
  repo: string,
  filePath: string,
  token?: string
): Promise<string> {
  const auth = token ? { accessToken: token as AccessToken } : {}
  return downloadFileToCacheDir({
    repo,
    path: filePath,
    ...auth,
  })
}

async function downloadViaCli(
  cmd: string,
  repo: string,
  files: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["download", repo, ...files]
    const proc = spawn(cmd, args, { stdio: "inherit" })
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    )
    proc.on("error", reject)
  })
}

export async function downloadFiles(
  repo: string,
  paths: string[],
  token?: string
): Promise<void> {
  for (const p of paths) {
    try {
      await downloadViaJsSdk(repo, p, token)
      continue
    } catch (err) {
      if (existsSync(String(err))) continue
      // JS SDK not available or failed, try CLI fallback
    }

    for (const cmd of ["hf", "huggingface-cli"]) {
      try {
        await downloadViaCli(cmd, repo, [p])
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
    }
  }
}

export async function pullGguf(
  repo: string,
  opts?: { token?: string; dest?: string; listOnly?: boolean }
): Promise<void> {
  const token = opts?.token ?? process.env.HF_TOKEN

  const files = await listGgufFiles(repo, token)
  if (files.length === 0) {
    console.log("  No GGUF files found in this repo.")
    return
  }

  const baseFiles = files.filter((f) => !f.isMmproj)
  const mmprojFiles = files.filter((f) => f.isMmproj)

  console.log(`\n  GGUF files in ${repo}:\n`)
  console.log(`  ${"FILE".padEnd(60)} ${"SIZE".padEnd(12)} ${"AUTO"}`)
  console.log(`  ${"─".repeat(60)} ${"─".repeat(12)} ${"─".repeat(6)}`)

  for (const f of [...baseFiles, ...mmprojFiles]) {
    const name = f.path.split("/").pop() ?? f.path
    const displayName = name.length > 58 ? name.slice(0, 55) + "..." : name
    const sizeStr = formatBytes(f.size)
    const auto = f.isMmproj ? "● (auto)" : "●"
    console.log(`  ${displayName.padEnd(60)} ${sizeStr.padEnd(12)} ${auto}`)
  }

  if (opts?.listOnly) return

  const downloadList = autoSelectMmproj(
    baseFiles.length > 0 ? [baseFiles[0]!] : [],
    files
  )

  console.log(`\n  Downloading ${downloadList.length} file(s)...`)
  await downloadFiles(
    repo,
    downloadList.map((f) => f.path),
    token
  )
  console.log("\n  Done. Run `homestead discover` to register.")
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}
