import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
 * 执行迁移（幂等）：直接写 sentinel 跳过旧数据，旧 data/ 不再迁入。
 * 返回 true 表示本次执行了迁移。
 */
export function migrateWorkspace(opts: MigrateOptions): boolean {
  if (!migrationNeeded(opts)) return false;

  // 只写 sentinel，标记已处理。旧 data/ 数据废弃，不再迁移
  mkdirSync(dirname(opts.sentinelPath), { recursive: true });
  writeFileSync(opts.sentinelPath, new Date().toISOString(), "utf8");
  return true;
}
