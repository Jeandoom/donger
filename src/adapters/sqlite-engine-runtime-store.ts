import type { Database } from "better-sqlite3";
import type { EngineRuntimeRecord } from "../ports/engine-runtime-store.js";
import type { EngineRuntimeStore } from "../ports/engine-runtime-store.js";

type Row = Record<string, unknown>;

const SEEDS: Array<Pick<EngineRuntimeRecord, "sdkType" | "sourceKind" | "status">> = [
  { sdkType: "anthropic", sourceKind: "bundled", status: "ready" },
  { sdkType: "openai", sourceKind: "bundled", status: "ready" },
  // zcode 工件未钉版：missing（解析链落桌面候选降级态，UI 显性标「未钉版」）
  { sdkType: "zcode", sourceKind: "discover", status: "missing" },
];

/** engine_runtimes 表（单行单资产：更换=重装覆盖，M1 不做版本轮换） */
export class SqliteEngineRuntimeStore implements EngineRuntimeStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engine_runtimes (
        sdkType TEXT PRIMARY KEY,
        sourceKind TEXT NOT NULL,
        sourceRef TEXT,
        pinnedVersion TEXT,
        installedPath TEXT,
        sha256 TEXT,
        managed INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        lastError TEXT,
        lastSmokeAt TEXT,
        updatedAt TEXT NOT NULL
      );
    `);
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO engine_runtimes (sdkType, sourceKind, managed, status, updatedAt)
       VALUES (?, ?, 1, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const s of SEEDS) ins.run(s.sdkType, s.sourceKind, s.status, now);
  }

  async list(): Promise<EngineRuntimeRecord[]> {
    const rows = this.db.prepare("SELECT * FROM engine_runtimes ORDER BY sdkType").all() as Row[];
    return rows.map((r) => this.rowToRecord(r));
  }

  async get(sdkType: string): Promise<EngineRuntimeRecord | undefined> {
    const r = this.db.prepare("SELECT * FROM engine_runtimes WHERE sdkType = ?").get(sdkType) as
      | Row
      | undefined;
    return r ? this.rowToRecord(r) : undefined;
  }

  async upsert(record: EngineRuntimeRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO engine_runtimes
         (sdkType,sourceKind,sourceRef,pinnedVersion,installedPath,sha256,managed,status,lastError,lastSmokeAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(sdkType) DO UPDATE SET
           sourceKind=excluded.sourceKind, sourceRef=excluded.sourceRef,
           pinnedVersion=excluded.pinnedVersion, installedPath=excluded.installedPath,
           sha256=excluded.sha256, managed=excluded.managed, status=excluded.status,
           lastError=excluded.lastError, lastSmokeAt=excluded.lastSmokeAt,
           updatedAt=excluded.updatedAt`,
      )
      .run(
        record.sdkType,
        record.sourceKind,
        record.sourceRef ?? null,
        record.pinnedVersion ?? null,
        record.installedPath ?? null,
        record.sha256 ?? null,
        record.managed ? 1 : 0,
        record.status,
        record.lastError ?? null,
        record.lastSmokeAt ?? null,
        record.updatedAt,
      );
  }

  private rowToRecord(r: Row): EngineRuntimeRecord {
    return {
      sdkType: r.sdkType as string,
      sourceKind: r.sourceKind as EngineRuntimeRecord["sourceKind"],
      sourceRef: (r.sourceRef as string) ?? undefined,
      pinnedVersion: (r.pinnedVersion as string) ?? undefined,
      installedPath: (r.installedPath as string) ?? undefined,
      sha256: (r.sha256 as string) ?? undefined,
      managed: r.managed === 1,
      status: r.status as EngineRuntimeRecord["status"],
      lastError: (r.lastError as string) ?? undefined,
      lastSmokeAt: (r.lastSmokeAt as string) ?? undefined,
      updatedAt: r.updatedAt as string,
    };
  }
}
