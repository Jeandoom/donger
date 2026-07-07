/**
 * 统一身份模型迁移脚本（幂等，可重复执行）。
 *
 * 背景：旧模型用 users.staffId 作为登录主键；新模型以 user_identities 为唯一入口。
 * 本脚本把既有用户的 staffId 回填为一条 dingtalk identity，并清理 staffId 唯一索引，
 * 让历史用户在「钉钉 IM（senderStaffId）」入口下仍可被 getOrCreateByIdentity 命中。
 *
 * 做了什么：
 *   1. 遍历 users 表，读取 data JSON 里残留的 staffId；
 *   2. 为每个有 staffId 的用户补一条 (provider="dingtalk", externalId=staffId) 的 identity（已存在则跳过）；
 *   3. 删除 users.staffId 的唯一索引（idx_users_staffId）——SQLite 不支持 DROP COLUMN，
 *      staffId 列本身保留但不再写入、不再约束。
 *
 * 用法：node scripts/migrate-identity-model.ts（默认读写 ~/.donger/donger.db）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";

/** 旧版 User 的 JSON 形状（仅取迁移所需字段） */
interface LegacyUserData {
  id: string;
  // 旧字段，迁移后不再使用；迁移期读取以回填 identity。
  staffId?: string;
}

function main(): void {
  const cfg = loadConfig(process.env);
  const dbPath = cfg.dbPath || join(homedir(), ".donger", "donger.db");
  const db = new Database(dbPath);

  // 表不存在（全新部署）→ 无需迁移
  const hasUsers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { name: string } | undefined;
  if (!hasUsers) {
    console.log("[migrate] users 表不存在，跳过迁移。");
    db.close();
    return;
  }

  const trx = db.transaction(() => {
    const rows = db.prepare("SELECT id, data FROM users").all() as {
      id: string;
      data: string;
    }[];

    let backfilled = 0;
    let skipped = 0;
    const insertIdentity = db.prepare(
      "INSERT OR IGNORE INTO user_identities (id, userId, provider, externalId, createdAt) VALUES (?, ?, 'dingtalk', ?, ?)",
    );

    for (const row of rows) {
      let parsed: LegacyUserData;
      try {
        parsed = JSON.parse(row.data) as LegacyUserData;
      } catch {
        console.warn(`[migrate] 跳过无法解析的 user: ${row.id}`);
        skipped++;
        continue;
      }
      if (!parsed.staffId) {
        skipped++;
        continue;
      }
      const result = insertIdentity.run(
        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        row.id,
        parsed.staffId,
        new Date().toISOString(),
      );
      if (result.changes > 0) backfilled++;
    }

    // 删除 staffId 唯一索引（列保留但废弃）
    db.exec("DROP INDEX IF EXISTS idx_users_staffId");

    console.log(
      `[migrate] 完成：回填 identity ${backfilled} 条，跳过 ${skipped} 条，共 ${rows.length} 个用户。`,
    );
  });

  trx();
  db.close();
}

main();
