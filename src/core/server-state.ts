import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ServingProcess } from "../types.js"

const STATE_DIR = join(homedir(), ".homestead")
const STATE_FILE = join(STATE_DIR, "servers.json")

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function loadRaw(): ServingProcess[] {
  try {
    if (!existsSync(STATE_FILE)) return []
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return Array.isArray(parsed) ? (parsed as ServingProcess[]) : []
  } catch {
    return []
  }
}

function save(list: ServingProcess[]): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${STATE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2))
    renameSync(tmp, STATE_FILE)
  } catch {
    // best effort — state is advisory only
  }
}

/**
 * Persisted view of running servers, shared across processes so that
 * `homestead stop`, `homestead status`, and the UI can manage servers that
 * were started by another process. Entries with dead PIDs are pruned.
 */
export function loadServers(): ServingProcess[] {
  return loadRaw().filter((s) => pidAlive(s.pid))
}

export function addServer(sp: ServingProcess): void {
  if (!(sp.pid > 0)) return
  const list = loadRaw().filter((s) => s.modelId !== sp.modelId)
  list.push(sp)
  save(list)
}

export function removeServer(modelId: string): void {
  save(loadRaw().filter((s) => s.modelId !== modelId))
}

export function findServer(modelId: string): ServingProcess | null {
  return loadRaw().find((s) => s.modelId === modelId) ?? null
}
