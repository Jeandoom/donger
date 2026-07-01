import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { initUserWorkspace } from "./workspace.js";

export interface MigrateOptions {
  oldDataDir: string;
  newDbPath: string;
  newWorkspaceDir: string;
  sentinelPath: string;
}

export function migrationNeeded(opts: MigrateOptions): boolean {
  const oldDb = join(opts.oldDataDir, "donger.db");
  const oldUsers = join(opts.oldDataDir, "users");
  return (
    (existsSync(oldDb) || existsSync(oldUsers)) && !existsSync(opts.sentinelPath)
  );
}

/**
 * 执行迁移（幂等）：DB+用户 memory 迁到新布局，旧 repos/.worktrees 丢弃，
 * 旧 data/ 重命名为 data.bak 留底，写 sentinel 防重。
 * 返回 true 表示本次执行了迁移。
 */
export function migrateWorkspace(opts: MigrateOptions): boolean {
  if (!migrationNeeded(opts)) return false;

  // 1. DB
  const oldDb = join(opts.oldDataDir, "donger.db");
  if (existsSync(oldDb)) {
    mkdirSync(dirname(opts.newDbPath), { recursive: true });
    copyFileSync(oldDb, opts.newDbPath);
  }

  // 2. 用户 memory → knowledge_base/user/
  const oldUsers = join(opts.oldDataDir, "users");
  if (existsSync(oldUsers)) {
    for (const userId of readdirSync(oldUsers)) {
      const oldUser = join(oldUsers, userId);
      if (!existsSync(join(oldUser, "memory"))) continue;
      const newUserWs = join(opts.newWorkspaceDir, "users", userId);
      initUserWorkspace(newUserWs);
      const oldMemory = join(oldUser, "memory");
      if (existsSync(oldMemory)) {
        const dest = join(newUserWs, "knowledge_base", "user");
        for (const f of readdirSync(oldMemory)) {
          copyFileSync(join(oldMemory, f), join(dest, f));
        }
      }
      // repos/.worktrees 不迁
    }
  }

  // 3. 旧 data → data.bak（留底）
  renameSync(opts.oldDataDir, `${opts.oldDataDir}.bak`);

  // 4. sentinel
  mkdirSync(dirname(opts.sentinelPath), { recursive: true });
  writeFileSync(opts.sentinelPath, new Date().toISOString(), "utf8");
  return true;
}
