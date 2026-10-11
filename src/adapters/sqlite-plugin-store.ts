import type { Database } from "better-sqlite3";
import type { PluginRecord, PluginScope, PluginSource, PluginStatus } from "../domain/plugin.js";
import type { PluginStore } from "../ports/plugin-store.js";

type Row = Record<string, unknown>;

/** plugins 表（治理面：清单/启停/依赖/状态；specs/2026-10-11-plugin-system-design.md §9.1） */
export class SqlitePluginStore implements PluginStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        version TEXT,
        core INTEGER NOT NULL DEFAULT 0,
        stoppable INTEGER NOT NULL DEFAULT 1,
        scope TEXT,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT,
        requires TEXT NOT NULL DEFAULT '[]',
        installedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  async list(): Promise<PluginRecord[]> {
    const rows = this.db.prepare("SELECT * FROM plugins ORDER BY id").all() as Row[];
    return rows.map((r) => this.rowToRecord(r));
  }

  async get(id: string): Promise<PluginRecord | undefined> {
    const r = this.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToRecord(r) : undefined;
  }

  async upsert(record: PluginRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO plugins
         (id,kind,version,core,stoppable,scope,source,enabled,status,error,requires,installedAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, version=excluded.version, core=excluded.core,
           stoppable=excluded.stoppable, scope=excluded.scope, source=excluded.source,
           status=excluded.status, error=excluded.error, requires=excluded.requires,
           updatedAt=excluded.updatedAt`,
      )
      .run(
        record.id,
        record.kind,
        record.version ?? null,
        record.core ? 1 : 0,
        record.stoppable ? 1 : 0,
        record.scope ?? null,
        record.source,
        // enabled 只在首插时生效；对账的 DO UPDATE 不含该列，不会覆盖 admin 启停决策
        record.enabled ? 1 : 0,
        record.status,
        record.error ?? null,
        JSON.stringify(record.requires),
        record.installedAt,
        record.updatedAt,
      );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.db
      .prepare("UPDATE plugins SET enabled = ?, updatedAt = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  async setStatus(id: string, status: PluginStatus, error?: string): Promise<void> {
    this.db
      .prepare("UPDATE plugins SET status = ?, error = ?, updatedAt = ? WHERE id = ?")
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  private rowToRecord(r: Row): PluginRecord {
    return {
      id: r.id as string,
      kind: r.kind as PluginRecord["kind"],
      version: (r.version as string) ?? undefined,
      core: r.core === 1,
      stoppable: r.stoppable === 1,
      scope: (r.scope as PluginScope) ?? undefined,
      source: r.source as PluginSource,
      enabled: r.enabled === 1,
      status: r.status as PluginStatus,
      error: (r.error as string) ?? undefined,
      requires: JSON.parse((r.requires as string) ?? "[]") as string[],
      installedAt: r.installedAt as string,
      updatedAt: r.updatedAt as string,
    };
  }
}
