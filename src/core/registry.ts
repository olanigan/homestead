import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { ModelRecord, ModelSource, ModelStatus, ModelFormat, RegistryStats } from "../types.js"

interface RawRow {
  id: string
  name: string
  source: string
  source_id: string
  path: string
  size_bytes: number
  format: string
  quantization: string | null
  engine: string | null
  status: string
  metadata: string
  discovered_at: string
  updated_at: string
}

function rowToModel(row: RawRow): ModelRecord {
  return {
    id: row.id,
    name: row.name,
    source: row.source as ModelSource,
    sourceId: row.source_id,
    path: row.path,
    sizeBytes: row.size_bytes ?? 0,
    format: row.format as ModelFormat,
    quantization: row.quantization,
    engine: row.engine as ModelRecord["engine"],
    status: row.status as ModelStatus,
    metadata: JSON.parse(row.metadata || "{}"),
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  }
}

export class Registry {
  private db: Database

  constructor(dbPath: string = "") {
    const oldDir = join(homedir(), ".localai")
    const newDir = join(homedir(), ".homestead")
    const dataDir = existsSync(newDir) || !existsSync(oldDir) ? newDir : oldDir
    mkdirSync(dataDir, { recursive: true })
    const path = dbPath || process.env.HOMESTEAD_DB_PATH || process.env.LAI_DB_PATH || join(dataDir, "models.db")
    this.db = new Database(path)

    this.db.run(`CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'unknown',
      quantization TEXT,
      engine TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      metadata TEXT NOT NULL DEFAULT '{}',
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)

    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_models_source_id ON models(source, source_id)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_models_status ON models(status)`)
  }

  upsert(model: ModelRecord): void {
    const existing = this.db.query(`SELECT id FROM models WHERE source = $1 AND source_id = $2`).get(model.source, model.sourceId) as { id: string } | null
    if (existing) {
      this.db.run(
        `UPDATE models SET name=$1, path=$2, size_bytes=$3, format=$4, quantization=$5, engine=$6, status=$7, metadata=$8, updated_at=$9 WHERE id=$10`,
        [model.name, model.path, model.sizeBytes, model.format, model.quantization, model.engine, model.status, JSON.stringify(model.metadata), model.updatedAt, existing.id]
      )
    } else {
      this.db.run(
        `INSERT INTO models (id, name, source, source_id, path, size_bytes, format, quantization, engine, status, metadata, discovered_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [model.id, model.name, model.source, model.sourceId, model.path, model.sizeBytes, model.format, model.quantization, model.engine, model.status, JSON.stringify(model.metadata), model.discoveredAt, model.updatedAt]
      )
    }
  }

  upsertMany(models: ModelRecord[]): { inserted: number; updated: number } {
    let inserted = 0
    let updated = 0
    const tx = this.db.transaction(() => {
      for (const m of models) {
        const existing = this.db.query(`SELECT id FROM models WHERE source = $1 AND source_id = $2`).get(m.source, m.sourceId) as { id: string } | null
        if (existing) {
          this.db.run(
            `UPDATE models SET name=$1, path=$2, size_bytes=$3, format=$4, quantization=$5, engine=$6, status=$7, metadata=$8, updated_at=$9 WHERE id=$10`,
            [m.name, m.path, m.sizeBytes, m.format, m.quantization, m.engine, m.status, JSON.stringify(m.metadata), m.updatedAt, existing.id]
          )
          updated++
        } else {
          this.db.run(
            `INSERT INTO models (id, name, source, source_id, path, size_bytes, format, quantization, engine, status, metadata, discovered_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [m.id, m.name, m.source, m.sourceId, m.path, m.sizeBytes, m.format, m.quantization, m.engine, m.status, JSON.stringify(m.metadata), m.discoveredAt, m.updatedAt]
          )
          inserted++
        }
      }
    })
    tx()
    return { inserted, updated }
  }

  list(source?: ModelSource): ModelRecord[] {
    const rows: RawRow[] = source
      ? this.db.query(`SELECT * FROM models WHERE source = ? ORDER BY size_bytes DESC`).all(source) as RawRow[]
      : this.db.query(`SELECT * FROM models ORDER BY size_bytes DESC`).all() as RawRow[]
    return rows.map(rowToModel)
  }

  get(idOrName: string): ModelRecord | null {
    const row = this.db.prepare(`SELECT * FROM models WHERE id = ? OR name = ? LIMIT 1`).get(idOrName, idOrName) as RawRow | null
    return row ? rowToModel(row) : null
  }

  search(query: string): ModelRecord[] {
    const q = `%${query}%`
    const rows = this.db.prepare(`SELECT * FROM models WHERE name LIKE ? OR source LIKE ? OR format LIKE ? ORDER BY size_bytes DESC`).all(q, q, q) as RawRow[]
    return rows.map(rowToModel)
  }

  updateStatus(id: string, status: ModelStatus): void {
    this.db.prepare(`UPDATE models SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id)
  }

  updateStatusMany(ids: string[], status: ModelStatus): void {
    const stmt = this.db.prepare(`UPDATE models SET status = ?, updated_at = ? WHERE id = ?`)
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(status, new Date().toISOString(), id)
      }
    })
    tx()
  }

  delete(id: string): boolean {
    try {
      const result = this.db.prepare(`DELETE FROM models WHERE id = ?`).run(id)
      return result ? result.changes > 0 : true
    } catch {
      this.db.run(`DELETE FROM models WHERE id = $1`, [id])
      return true
    }
  }

  deleteBySource(source: string): number {
    try {
      const result = this.db.prepare(`DELETE FROM models WHERE source = ?`).run(source)
      return result ? result.changes : 0
    } catch {
      this.db.run(`DELETE FROM models WHERE source = $1`, [source])
      return 0
    }
  }

  stats(): RegistryStats {
    const total = this.db.query(`SELECT COUNT(*) as count FROM models`).get() as { count: number }
    const bySource = this.db.query(`SELECT source, COUNT(*) as count FROM models GROUP BY source`).all() as { source: ModelSource; count: number }[]
    const byStatus = this.db.query(`SELECT status, COUNT(*) as count FROM models GROUP BY status`).all() as { status: ModelStatus; count: number }[]
    const byFormat = this.db.query(`SELECT format, COUNT(*) as count FROM models GROUP BY format`).all() as { format: ModelFormat; count: number }[]
    const sizeTotal = this.db.query(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM models`).get() as { total: number }
    const serving = this.db.query(`SELECT COUNT(*) as count FROM models WHERE status = 'serving'`).get() as { count: number }
    const incomplete = this.db.query(`SELECT COUNT(*) as count FROM models WHERE status = 'incomplete'`).get() as { count: number }

    const bySrc: Record<string, number> = Object.fromEntries(bySource.map((r) => [r.source, r.count]))
    const bySt: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.status, r.count]))
    const byFmt: Record<string, number> = Object.fromEntries(byFormat.map((r) => [r.format, r.count]))
    return {
      totalModels: total.count,
      bySource: bySrc as RegistryStats["bySource"],
      byStatus: bySt as RegistryStats["byStatus"],
      byFormat: byFmt as RegistryStats["byFormat"],
      totalSizeBytes: sizeTotal.total,
      servingCount: serving.count,
      incompleteCount: incomplete.count,
    }
  }

  /**
   * Remove duplicate rows where the same sourceId exists under two different sources.
   * Keeps rows with `preferred` source, deletes matching rows with `secondary` source.
   * Returns count of removed rows.
   */
  dedupCrossSource(preferred: ModelSource, secondary: ModelSource): number {
    const rows = this.db.query(
      `SELECT m.id FROM models m
       INNER JOIN models p ON m.source_id = p.source_id AND p.source = $1
       WHERE m.source = $2`
    ).all(preferred, secondary) as { id: string }[]

    if (rows.length === 0) return 0

    const ids = rows.map((r) => r.id)
    const stmt = this.db.prepare(`DELETE FROM models WHERE id = ?`)
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(id)
      }
    })
    tx()
    return ids.length
  }

  close(): void {
    this.db.close()
  }
}
