import type { Database } from "better-sqlite3";

/** 渠道自持连接配置行（config JSON 由上层 SecretCipher 加密） */
export interface ChannelConnectionConfigRow {
  platform: string;
  /** 加密后的配置 JSON（SecretCipher.encrypt） */
  config: string;
  enabled: number;
  updatedAt: string;
}

/**
 * 渠道自持连接配置存储（2026-11-05 统一通知设计 §2.2，拍板 D6 混合）：
 * 仅承载 configSource="connection" 的渠道（如飞书样板）——引用授权页 module_configs
 * 的渠道（钉钉/SMTP/TB）不经此表。config 明文只在适配器层短暂解密，API 永不回显。
 */
export class SqliteChannelConnectionStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_connections (
        platform   TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updatedAt  TEXT NOT NULL
      )
    `);
  }

  get(platform: string): ChannelConnectionConfigRow | undefined {
    return this.db
      .prepare("SELECT * FROM channel_connections WHERE platform = ?")
      .get(platform) as ChannelConnectionConfigRow | undefined;
  }

  list(): ChannelConnectionConfigRow[] {
    return this.db.prepare("SELECT * FROM channel_connections").all() as ChannelConnectionConfigRow[];
  }

  put(platform: string, configEncrypted: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO channel_connections (platform, config, enabled, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           config = excluded.config, enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
      )
      .run(platform, configEncrypted, enabled ? 1 : 0, new Date().toISOString());
  }

  setEnabled(platform: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE channel_connections SET enabled = ?, updatedAt = ? WHERE platform = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), platform);
  }
}
