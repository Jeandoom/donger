// 会话 worktree 清道夫（2026-10-14 并行会话分支冲突轮）。
// 会话没有"结束"钩子（archive 仅软标记），worktree 回收走周期清扫：
// 归档或闲置超龄的会话 → 回收其 worktree（干净才删，git 对脏树/未跟踪文件/未合并
// 分支一律拒绝，未提交工作永不丢）。语义对齐 Claude Code 官方 worktree 清理策略。
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SESSION_BRANCH_PREFIX } from "../domain/git.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import { runGit } from "../util/git-process.js";

export interface WorktreeGcDeps {
  workspaceDir: string;
  conversationStore: Pick<ConversationStore, "get">;
  /** 会话闲置判定阈值毫秒（距 updatedAt；归档会话立即超龄）。默认 7 天 */
  retentionMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface WorktreeGcSummary {
  /** 扫描的会话 worktree 目录数 */
  scanned: number;
  /** 成功回收的 worktree 数 */
  removedWorktrees: number;
  /** 因有未提交工作（脏树/未跟踪文件）被 git 拒绝而保留的 worktree 数 */
  keptDirty: number;
  /** worktree 已回收但会话分支未合并被 -d 拒绝而保留的分支数 */
  keptBranches: number;
}

/** 单次清扫：遍历 users 下各 agent 工作区的 worktrees 目录，回收超龄/归档会话的 worktree */
export async function sweepSessionWorktrees(deps: WorktreeGcDeps): Promise<WorktreeGcSummary> {
  const retentionMs = deps.retentionMs ?? 7 * 24 * 3_600_000;
  const now = deps.now ?? Date.now;
  const summary: WorktreeGcSummary = {
    scanned: 0,
    removedWorktrees: 0,
    keptDirty: 0,
    keptBranches: 0,
  };
  const usersRoot = join(deps.workspaceDir, "users");
  if (!existsSync(usersRoot)) return summary;
  const prunedRoots = new Set<string>();
  for (const userDir of listDirs(usersRoot)) {
    const agentsRoot = join(usersRoot, userDir, "agents");
    if (!existsSync(agentsRoot)) continue;
    for (const agentDir of listDirs(agentsRoot)) {
      const wtRoot = join(agentsRoot, agentDir, "workspace", "worktrees");
      if (!existsSync(wtRoot)) continue;
      for (const convId of listDirs(wtRoot)) {
        summary.scanned++;
        if (!(await isStale(deps, convId, retentionMs, now))) continue;
        const convRepos = join(wtRoot, convId, "repos");
        if (!existsSync(convRepos)) {
          rmSync(join(wtRoot, convId), { recursive: true, force: true });
          continue;
        }
        let allRemoved = true;
        for (const entry of listDirs(convRepos)) {
          const repoDir = join(convRepos, entry);
          // .stale-* 是物化器自愈时的改名备份：会话已超龄，现场语义保留期已过，直接清
          if (/\.stale-/.test(entry)) {
            rmSync(repoDir, { recursive: true, force: true });
            continue;
          }
          const outcome = await removeSessionWorktree(deps, repoDir, convId, prunedRoots);
          if (outcome.removed) summary.removedWorktrees++;
          else summary.keptDirty++;
          if (outcome.branchKept) summary.keptBranches++;
          if (!outcome.removed) allRemoved = false;
        }
        if (allRemoved) rmSync(join(wtRoot, convId), { recursive: true, force: true });
      }
    }
  }
  return summary;
}

/** 周期清扫循环（进程内 setInterval；fire-and-forget，失败静默）。返回停止函数。 */
export function startWorktreeGc(deps: WorktreeGcDeps & { intervalMs?: number }): () => void {
  const intervalMs = deps.intervalMs ?? 3_600_000;
  const timer = setInterval(() => {
    void sweepSessionWorktrees(deps).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function isStale(
  deps: WorktreeGcDeps,
  convId: string,
  retentionMs: number,
  now: () => number,
): Promise<boolean> {
  try {
    const conv = await deps.conversationStore.get(convId);
    if (!conv) return true;
    if (conv.archived) return true;
    return now() - Date.parse(conv.updatedAt) > retentionMs;
  } catch {
    return false; // store 异常 fail-open：保留现场
  }
}

/**
 * 回收单个会话 worktree。removed=false 表示 git 拒绝（脏树/未跟踪文件=有未提交工作），
 * branchKept=true 表示 worktree 已删但会话分支未合并被 -d 拒绝（提交现场保留在分支里）。
 */
async function removeSessionWorktree(
  deps: WorktreeGcDeps,
  repoDir: string,
  convId: string,
  prunedRoots: Set<string>,
): Promise<{ removed: boolean; branchKept: boolean }> {
  const timeout = deps.timeoutMs ?? 30_000;
  const commonDir = await runGit(
    ["-C", repoDir, "rev-parse", "--git-common-dir"],
    undefined,
    timeout,
  );
  if (commonDir.code !== 0) return { removed: false, branchKept: false }; // 非 git 工作树，不动
  const mainRoot = dirname(resolve(repoDir, commonDir.stdout.trim()));
  if (resolve(repoDir) === mainRoot) return { removed: false, branchKept: false }; // 主工作树，不归 GC 管
  // 不带 --force：git 对脏树/未跟踪文件/锁定 worktree 直接拒绝
  const rm = await runGit(
    ["-C", mainRoot, "worktree", "remove", resolve(repoDir)],
    undefined,
    timeout,
  );
  if (rm.code !== 0) return { removed: false, branchKept: false };
  if (!prunedRoots.has(mainRoot)) {
    prunedRoots.add(mainRoot);
    await runGit(["-C", mainRoot, "worktree", "prune"], undefined, timeout);
  }
  // 会话分支安全删：-d 只删已合并（按 upstream/HEAD 判定）分支，未合并自动保留
  const del = await runGit(
    ["-C", mainRoot, "branch", "-d", SESSION_BRANCH_PREFIX + convId],
    undefined,
    timeout,
  );
  return { removed: true, branchKept: del.code !== 0 };
}

function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
