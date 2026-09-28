import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { KbLibrary } from "../domain/kb.js";
import type { KbLibraryStore } from "../ports/kb-store.js";
import { kbRootDir } from "./kb-files.js";

export interface KbMigrateDeps {
  libraryStore: KbLibraryStore;
  workspaceDir: string;
  /** <workspaceDir>/users（每用户 homeDir 的父目录） */
  usersDir: string;
  log?: { info(msg: string): void; warn(msg: string): void };
  /** FTS 影子索引（R-A）：并入内容后全量回填该库索引；缺省不回填（检索回落 grep） */
  kbFts?: { upsert(kbId: string, path: string, content: string): void };
}

export interface KbMigrateResult {
  ensuredPersonal: number;
  mergedLegacy: number;
  renameFailed: number;
}

/**
 * 知识库统一迁移（spec 2026-09-22-knowledge-base-design §5.3，幂等）：
 * 1) 每个存量用户 ensure 个人知识库（无则建，含目录）；
 * 2) 旧 <userWs>/knowledge_base/ 内容并入个人库（user/* → memory/*，其余按原名）；
 * 3) 旧目录整目录 rename 为 knowledge_base.retired-<ts>（不删除，保底可回滚）。
 * 每用户以"旧目录是否存在"为天然幂等判定；rename 失败（如 Windows EBUSY 并发占用）
 * 仅计数告警不阻断启动，下次启动重试（拷贝为覆盖式，幂等收敛）。
 */
export async function migrateKnowledgeBases(deps: KbMigrateDeps): Promise<KbMigrateResult> {
  const result: KbMigrateResult = { ensuredPersonal: 0, mergedLegacy: 0, renameFailed: 0 };
  let userDirs: string[];
  try {
    userDirs = readdirSync(deps.usersDir);
  } catch {
    return result;
  }
  for (const userId of userDirs) {
    const userWs = join(deps.usersDir, userId);
    let personal: KbLibrary;
    try {
      const before = await deps.libraryStore.findPersonalByOwner(userId);
      personal = await deps.libraryStore.ensurePersonalLibrary(userId);
      if (!before) result.ensuredPersonal++;
    } catch {
      // 用户目录可能是非用户实体或 store 异常：跳过该目录，不阻断整体迁移
      continue;
    }
    const personalDir = kbRootDir(deps.workspaceDir, personal.id);
    mkdirSync(personalDir, { recursive: true });

    const legacyDir = join(userWs, "knowledge_base");
    if (!existsSync(legacyDir)) continue;
    try {
      mergeLegacyDir(legacyDir, personalDir);
      const retired = `${legacyDir}.retired-${Date.now()}`;
      renameSync(legacyDir, retired);
      // FTS 索引回填（R-A）：全量扫该库 .md（新库此时只有并入内容，成本低）
      if (deps.kbFts) {
        ftsBackfill(deps.kbFts, personal.id, personalDir);
      }
      result.mergedLegacy++;
      deps.log?.info(
        `知识库迁移：用户 ${userId} 旧 knowledge_base/ 已并入个人库 ${personal.id} 并退役`,
      );
    } catch (e) {
      result.renameFailed++;
      deps.log?.warn(
        `知识库迁移：用户 ${userId} 旧目录处理失败（下次启动重试）：${(e as Error).message}`,
      );
    }
  }
  return result;
}

/** 旧目录并入个人库：user/* → memory/*（MemoryStore 新根），其余子目录按原名平移（覆盖式，幂等） */
function mergeLegacyDir(legacyDir: string, personalDir: string): void {
  for (const entry of readdirSync(legacyDir)) {
    const src = join(legacyDir, entry);
    const dest = join(personalDir, entry === "user" ? "memory" : entry);
    cpSync(src, dest, { recursive: true });
  }
}

/** 递归回填 .md 文件的 FTS 索引（跳过隐藏与 assets） */
function ftsBackfill(
  fts: { upsert(kbId: string, path: string, content: string): void },
  kbId: string,
  root: string,
  relPrefix = "",
): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "assets") continue;
    const full = join(root, name);
    const rel = relPrefix === "" ? name : `${relPrefix}/${name}`;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      ftsBackfill(fts, kbId, full, rel);
    } else if (stat.isFile() && name.toLowerCase().endsWith(".md")) {
      try {
        fts.upsert(kbId, rel, readFileSync(full, "utf8"));
      } catch {
        // 单文件索引失败不阻断迁移
      }
    }
  }
}
