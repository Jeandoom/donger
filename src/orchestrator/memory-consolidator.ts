import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KbLibrary } from "../domain/kb.js";
import { MemoryStore } from "../memory/memory-store.js";
import { kbRootDir } from "../util/kb-files.js";

/**
 * 记忆闲时整理器（知识体系轮 P5）：平台常驻进程内低峰定时任务。
 * 动作（确定性，无 LLM——语义合并留待后续版本）：
 * ① created 超 retentionDays 且 type≠project 的 curated 条目 → archive/；
 * ② INDEX.md 行去重 + 按文件存在性清孤儿行；
 * ③ 索引超限（>200 行）通知库属主。
 * 每用户动作逐条汇总记一条 kb_revisions（actorKind=memory-consolidation）。
 */

export interface MemoryConsolidatorDeps {
  kbLibraryStore: {
    listAll(): Promise<Array<KbLibrary & { personal?: boolean }>>;
  };
  workspaceDir: string;
  revisionStore?: {
    record(input: {
      kbId: string;
      path: string;
      action: "update";
      actorUserId: string;
      actorKind: "memory-consolidation";
      summary?: string;
    }): Promise<unknown>;
  };
  notify?: (input: { userId: string; title: string; body: string; link: string }) => void;
  /** 归档阈值天数（type=project 豁免）；缺省 90 */
  retentionDays?: number;
  /** 触发间隔毫秒；缺省 1h（低峰判定由调用方 task 状态注入） */
  intervalMs?: number;
  /** 低峰判定：返回 true 才执行（如平台无 running task）；缺省恒可跑 */
  idleCheck?: () => boolean | Promise<boolean>;
}

const INDEX_LIMIT = 200;

export interface ConsolidationResult {
  userId: string;
  kbId: string;
  archived: number;
  indexLines: number;
  overLimit: boolean;
}

/** 对单个个人库执行一轮整理；无 memory 目录时返回 undefined。 */
export function consolidateMemory(
  kb: { id: string; ownerId: string },
  workspaceDir: string,
  deps: Pick<MemoryConsolidatorDeps, "retentionDays">,
): ConsolidationResult | undefined {
  const memDir = join(kbRootDir(workspaceDir, kb.id), "memory");
  if (!existsSync(memDir)) return undefined;
  const mem = new MemoryStore(memDir);
  const retentionDays = deps.retentionDays ?? 90;
  const cutoff = Date.now() - retentionDays * 86_400_000;

  // ① 超期归档（type=project 豁免；无 frontmatter 的条目按文件 mtime 粗判——读 created 字段优先）
  let archived = 0;
  const curatedDir = join(memDir, "curated");
  if (existsSync(curatedDir)) {
    const archiveDir = join(memDir, "archive");
    for (const f of readdirSync(curatedDir)) {
      if (!f.endsWith(".md") || f === "INDEX.md") continue;
      const abs = join(curatedDir, f);
      let exempt = false;
      let tooOld = false;
      try {
        const head = readFileSync(abs, "utf8").slice(0, 400);
        const created = /created:\s*(\d{4}-\d{2}-\d{2})/.exec(head)?.[1];
        const type = /type:\s*(\w+)/.exec(head)?.[1] ?? "project";
        exempt = type === "project";
        tooOld = created !== undefined && Date.parse(created) < cutoff;
      } catch {
        continue;
      }
      if (exempt || !tooOld) continue;
      mkdirSafe(archiveDir);
      renameSync(abs, join(archiveDir, f));
      archived++;
    }
  }

  // ② INDEX 清孤儿行 + 去重（保留首次出现）
  const indexPath = join(curatedDir, "INDEX.md");
  let lines: string[] = [];
  if (existsSync(indexPath)) {
    const seen = new Set<string>();
    for (const l of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!l.trim()) continue;
      const m = /\(([^)]+\.md)\)/.exec(l)?.[1];
      if (m && !existsSync(join(curatedDir, m))) continue; // 孤儿行（条目已归档/删除）
      const key = l.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(l);
    }
    writeFileSync(indexPath, lines.join("\n") + "\n", "utf8");
  }

  return {
    userId: kb.ownerId,
    kbId: kb.id,
    archived,
    indexLines: lines.length,
    overLimit: lines.length > INDEX_LIMIT,
  };
}

function mkdirSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 启动闲时整理循环（进程内 setInterval；fire-and-forget，失败静默）。返回停止函数。 */
export function startMemoryConsolidator(deps: MemoryConsolidatorDeps): () => void {
  const intervalMs = deps.intervalMs ?? 3_600_000;
  const timer = setInterval(() => {
    void runConsolidationCycle(deps).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function runConsolidationCycle(
  deps: MemoryConsolidatorDeps,
): Promise<ConsolidationResult[]> {
  if (deps.idleCheck && !(await deps.idleCheck())) return [];
  const libs = await deps.kbLibraryStore.listAll();
  const out: ConsolidationResult[] = [];
  for (const lib of libs) {
    if (!(lib as { personal?: boolean }).personal) continue;
    try {
      const r = consolidateMemory(lib, deps.workspaceDir, deps);
      if (!r) continue;
      out.push(r);
      if ((r.archived > 0 || r.overLimit) && deps.revisionStore) {
        await deps.revisionStore.record({
          kbId: r.kbId,
          path: "memory/curated/INDEX.md",
          action: "update",
          actorUserId: r.userId,
          actorKind: "memory-consolidation",
          summary: `闲时整理：归档 ${r.archived} 条，索引 ${r.indexLines} 行${r.overLimit ? "（超限）" : ""}`,
        });
      }
      if (r.overLimit && deps.notify) {
        deps.notify({
          userId: r.userId,
          title: "精选记忆索引超限",
          body: `curated 索引已达 ${r.indexLines} 行（上限 200）。超限部分不再注入会话，请整理或合并条目。`,
          link: "/kb",
        });
      }
    } catch {
      // 单库失败不阻断其他库
    }
  }
  return out;
}
