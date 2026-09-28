import type { Database } from "better-sqlite3";
import {
  APP_LOG_MAX_PER_APP,
  APP_LOG_RETENTION_DAYS,
  type AppManifest,
  type AppVersionMeta,
  type PlatformApp,
  parseAppManifest,
} from "../domain/app.js";
import type {
  AppDataEntry,
  AppLogEntry,
  AppLogRecord,
  AppStore,
  AppVersionWithMeta,
} from "../ports/app-store.js";

interface AppRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  icon: string | null;
  manifestJson: string;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteAppStore implements AppStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT,
        manifestJson TEXT NOT NULL,
        currentVersion INTEGER,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_versions (
        appId TEXT NOT NULL,
        num INTEGER NOT NULL,
        bundleBytes INTEGER NOT NULL,
        bundleSha256 TEXT NOT NULL,
        fileCount INTEGER NOT NULL,
        totalBytes INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        PRIMARY KEY (appId, num)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_data (
        appId TEXT NOT NULL,
        key TEXT NOT NULL,
        valueJson TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (appId, key)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_user ON apps (userId, updatedAt)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appId TEXT NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        method TEXT,
        path TEXT,
        status INTEGER,
        message TEXT,
        ts TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_app_logs_app ON app_logs (appId, id)`);
  }

  async create(input: {
    id: string;
    userId: string;
    name: string;
    description: string;
    icon?: string;
    manifest: AppManifest;
  }): Promise<PlatformApp> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO apps (id, userId, name, description, icon, manifestJson, currentVersion, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.name,
        input.description,
        input.icon ?? null,
        JSON.stringify(input.manifest),
        now,
        now,
      );
    const created = await this.get(input.id);
    if (!created) throw new Error(`应用创建失败: ${input.id}`);
    return created;
  }

  async get(appId: string): Promise<PlatformApp | undefined> {
    const row = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(appId) as AppRow | undefined;
    return row ? this.rowToApp(row) : undefined;
  }

  async listByUser(userId: string): Promise<PlatformApp[]> {
    const rows = this.db
      .prepare("SELECT * FROM apps WHERE userId = ? ORDER BY updatedAt DESC")
      .all(userId) as AppRow[];
    return rows.map((r) => this.rowToApp(r));
  }

  async update(
    appId: string,
    patch: Partial<Pick<PlatformApp, "name" | "description" | "icon" | "manifest">>,
  ): Promise<PlatformApp | undefined> {
    const app = await this.get(appId);
    if (!app) return undefined;
    const next = {
      name: patch.name ?? app.name,
      description: patch.description ?? app.description,
      icon: patch.icon === undefined ? app.icon : (patch.icon ?? undefined),
      manifest: patch.manifest ?? app.manifest,
    };
    this.db
      .prepare(
        `UPDATE apps SET name = ?, description = ?, icon = ?, manifestJson = ?, updatedAt = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.icon ?? null,
        JSON.stringify(next.manifest),
        new Date().toISOString(),
        appId,
      );
    return this.get(appId);
  }

  async delete(appId: string): Promise<void> {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM app_versions WHERE appId = ?").run(id);
      this.db.prepare("DELETE FROM app_data WHERE appId = ?").run(id);
      this.db.prepare("DELETE FROM app_logs WHERE appId = ?").run(id);
    });
    tx(appId);
  }

  async addVersion(
    appId: string,
    meta: Omit<AppVersionMeta, "appId" | "num">,
  ): Promise<AppVersionMeta> {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(num), 0) + 1 AS next FROM app_versions WHERE appId = ?")
      .get(appId) as { next: number };
    const num = next.next;
    this.db
      .prepare(
        `INSERT INTO app_versions (appId, num, bundleBytes, bundleSha256, fileCount, totalBytes, createdAt, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        appId,
        num,
        meta.bundleBytes,
        meta.bundleSha256,
        meta.fileCount,
        meta.totalBytes,
        meta.createdAt,
        meta.createdBy,
      );
    return { appId, num, ...meta };
  }

  async listVersions(appId: string): Promise<AppVersionWithMeta[]> {
    const app = await this.get(appId);
    const rows = this.db
      .prepare("SELECT * FROM app_versions WHERE appId = ? ORDER BY num DESC")
      .all(appId) as (AppVersionMeta & { isCurrent?: never })[];
    return rows.map((r) => ({ ...r, isCurrent: app?.currentVersion === r.num }));
  }

  async getVersion(appId: string, num: number): Promise<AppVersionMeta | undefined> {
    const row = this.db
      .prepare("SELECT * FROM app_versions WHERE appId = ? AND num = ?")
      .get(appId, num) as AppVersionMeta | undefined;
    return row;
  }

  async publishVersion(appId: string, num: number): Promise<PlatformApp | undefined> {
    const version = await this.getVersion(appId, num);
    if (!version) return undefined;
    this.db
      .prepare("UPDATE apps SET currentVersion = ?, updatedAt = ? WHERE id = ?")
      .run(num, new Date().toISOString(), appId);
    return this.get(appId);
  }

  async putData(entry: AppDataEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO app_data (appId, key, valueJson, sizeBytes, updatedAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (appId, key) DO UPDATE SET valueJson = excluded.valueJson, sizeBytes = excluded.sizeBytes, updatedAt = excluded.updatedAt`,
      )
      .run(entry.appId, entry.key, entry.valueJson, entry.sizeBytes, entry.updatedAt);
  }

  async getData(appId: string, key: string): Promise<AppDataEntry | undefined> {
    const row = this.db
      .prepare("SELECT * FROM app_data WHERE appId = ? AND key = ?")
      .get(appId, key) as AppDataEntry | undefined;
    return row;
  }

  async listData(appId: string): Promise<AppDataEntry[]> {
    return this.db
      .prepare("SELECT * FROM app_data WHERE appId = ? ORDER BY key")
      .all(appId) as AppDataEntry[];
  }

  async deleteData(appId: string, key: string): Promise<boolean> {
    const r = this.db.prepare("DELETE FROM app_data WHERE appId = ? AND key = ?").run(appId, key);
    return r.changes > 0;
  }

  async dataTotalBytes(appId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(sizeBytes), 0) AS total FROM app_data WHERE appId = ?")
      .get(appId) as { total: number };
    return row.total;
  }

  async appendLogs(appId: string, entries: AppLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO app_logs (appId, source, level, method, path, status, message, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: AppLogEntry[]) => {
      for (const e of rows) {
        insert.run(
          appId,
          e.source,
          e.level,
          e.method ?? null,
          e.path ?? null,
          e.status ?? null,
          e.message ?? null,
          e.ts,
        );
      }
      // 容量护栏：每应用只留最新 APP_LOG_MAX_PER_APP 条 + 过期清理
      this.db
        .prepare(
          `DELETE FROM app_logs WHERE appId = ? AND id NOT IN (
             SELECT id FROM app_logs WHERE appId = ? ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(appId, appId, APP_LOG_MAX_PER_APP);
      this.db
        .prepare(`DELETE FROM app_logs WHERE ts < ?`)
        .run(new Date(Date.now() - APP_LOG_RETENTION_DAYS * 86_400_000).toISOString());
    });
    tx(entries);
  }

  async listLogs(appId: string, limit: number): Promise<AppLogRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM app_logs WHERE appId = ? ORDER BY id DESC LIMIT ?`)
      .all(appId, Math.min(limit, 500)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      appId: r.appId as string,
      source: r.source as AppLogEntry["source"],
      level: r.level as AppLogEntry["level"],
      method: (r.method as string | null) ?? undefined,
      path: (r.path as string | null) ?? undefined,
      status: (r.status as number | null) ?? undefined,
      message: (r.message as string | null) ?? undefined,
      ts: r.ts as string,
    }));
  }

  private rowToApp(row: AppRow): PlatformApp {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      description: row.description,
      icon: row.icon ?? undefined,
      manifest: parseAppManifest(JSON.parse(row.manifestJson)),
      currentVersion: row.currentVersion ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
