import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";

/** 从 app_config 读取或生成 32 字节 hex 密钥并持久化（与 loadOrGenerateJwtSecret 同型）。 */
export function loadOrGenerateAppSecret(db: Database, keyName: string): string {
  db.exec(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(keyName) as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const v = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO app_config (key, value) VALUES (?, ?)").run(keyName, v);
  return v;
}
