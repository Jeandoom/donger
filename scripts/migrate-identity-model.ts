/**
 * 统一身份模型迁移脚本（幂等，可重复执行）。
 *
 * 背景：旧模型用 users.staffId 作为登录主键（NOT NULL UNIQUE）；新模型以 user_identities
 * 为唯一入口。旧 DB 升级到新代码时会因 staffId NOT NULL 约束导致新用户创建失败。
 *
 * 做了什么：
 *   1. schema 升级（复用 SqliteUserStore.migrate）：把旧 users 表重建为 staffId 可空，
 *      并确保 user_identities 表就绪；
 *   2. identity 回填：遍历 users，把 data JSON 里残留的 staffId 回填为一条
 *      (provider="dingtalk", externalId=staffId) 的 identity（已存在则跳过），
 *      让历史用户在钉钉扫码/IM 入口下仍可被 getOrCreateByIdentity 命中。
 *
 * 用法：node scripts/migrate-identity-model.ts（默认读写 ~/.donger/donger.db）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import "dotenv/config";
import Database from "better-sqlite3";
import { SqliteUserStore } from "../src/adapters/sqlite-user-store.js";
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
  const usersDir = join(cfg.workspaceDir, "users");

  // 1. schema 升级 + 建表（含 user_identities）。表不存在（全新部署）则直接建新版。
  const store = new SqliteUserStore(db, { adminExternalIds: cfg.adminExternalIds, usersDir });
  store.migrate();
  console.log("[migrate] schema 就绪：users.staffId 约束已放宽，user_identities 表已建。");

  // 2. 回填 identity
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

    console.log(
      `[migrate] identity 回填：${backfilled} 条，跳过 ${skipped} 条，共 ${rows.length} 个用户。`,
    );
  });

  trx();
  db.close();
  console.log("[migrate] 完成。");
}

main();
