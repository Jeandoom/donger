import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentGitRepository,
  buildCloneArgs,
  type GitRemoteAccessResult,
  normalizeRemoteUrlIdentity,
} from "../domain/git.js";
import type {
  GitProcessCredential,
  RepositoryMaterializeItem,
  RepositoryMaterializeRequest,
  RepositoryMaterializeResult,
  RepositoryMaterializer,
} from "../ports/repository-materializer.js";
import type { GitProcessResult } from "../util/git-process.js";
import { runGit, sanitizeGitError } from "../util/git-process.js";

export class GitCliRepositoryMaterializer implements RepositoryMaterializer {
  /** 目标目录 → 最近一次完成同步（clone 或 fastForward 往返）的时刻 */
  private readonly lastSyncAt = new Map<string, number>();

  constructor(
    private readonly timeoutMs = 120_000,
    /** 快进同步 TTL 窗口毫秒：窗口内已有目录直接 ready，跳过 status/fetch/merge 往返
     *  （慢网每轮数百 ms~数秒的固定开销；新鲜度代价=窗口时长。0=禁用，每轮强制同步） */
    private readonly syncTtlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async checkRead(
    repository: AgentGitRepository,
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitRemoteAccessResult> {
    const result = await this.runGitWithCredential(
      ["ls-remote", repository.url, "HEAD"],
      credential,
      signal,
    );
    if (result.code === 0) return { ok: true };
    return classifyRemoteFailure(result);
  }

  async materialize(request: RepositoryMaterializeRequest): Promise<RepositoryMaterializeResult[]> {
    const destination = resolve(request.destination);
    mkdirSync(destination, { recursive: true });
    const results: RepositoryMaterializeResult[] = [];
    for (const item of request.items) {
      if (request.signal?.aborted) throw new Error("Git 仓库准备已取消");
      results.push(await this.materializeOne(destination, item, request.signal));
    }
    return results;
  }

  private async materializeOne(
    destination: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
  ): Promise<RepositoryMaterializeResult> {
    const target = join(destination, item.repository.name);
    try {
      if (!existsSync(target)) {
        await this.clone(target, item, signal);
        this.lastSyncAt.set(target, this.now());
      } else if (item.repository.syncMode === "fastForward") {
        // TTL 窗口内复用已同步目录（目录真实性由窗口内首次同步的 remote 校验/自愈保证；
        // 表是进程内存态，重启后首轮强制同步一次，fail-safe）。
        const syncedAt = this.lastSyncAt.get(target);
        if (
          this.syncTtlMs <= 0 ||
          syncedAt === undefined ||
          this.now() - syncedAt >= this.syncTtlMs
        ) {
          const message = await this.fastForward(target, item, signal);
          this.lastSyncAt.set(target, this.now());
          if (message) return resultFor(item.repository, target, "warning", message);
        }
      }
      return resultFor(item.repository, target, "ready");
    } catch (error) {
      return resultFor(
        item.repository,
        target,
        "error",
        sanitizeGitError(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async clone(
    target: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
  ): Promise<void> {
    const temporary = `${target}.clone-${crypto.randomUUID()}`;
    const args = buildCloneArgs(item.repository, temporary);
    try {
      const result = await this.runGitWithCredential(args, item.credential, signal);
      if (result.code !== 0) throw new Error(result.stderr || "git clone 失败");
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    }
  }

  private async fastForward(
    target: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const remote = await this.runGitWithCredential(
      ["-C", target, "remote", "get-url", "origin"],
      undefined,
      signal,
    );
    if (remote.code !== 0 || !isSameRemote(remote.stdout, item.repository.url)) {
      // 已有目录无法确认是目标仓库（含读取失败/目录存在但不是 git 仓库）：备份后重克隆自愈，
      // 不再直接拒绝——拒绝会让任务走进无出路的死胡同（2026-09-10 连续两次失败无自愈）。
      const backup = await this.backupAndReclone(target, item, signal);
      return `已有目录不是目标仓库，已备份到 ${backup} 并重新克隆`;
    }
    const status = await this.runGitWithCredential(
      ["-C", target, "status", "--porcelain"],
      undefined,
      signal,
    );
    if (status.code !== 0) throw new Error(status.stderr || "读取仓库状态失败");
    if (status.stdout.trim()) return "仓库存在本地修改，已跳过自动更新";
    // 显式全量 refspec：旧的单分支浅克隆（--depth 1 隐含 single-branch）也能在此补齐全部分支引用，
    // 是「变更查询只见 master、误报零变更」的修复路径（2026-09-12 复盘 P0-1）。
    const fetchResult = await this.runGitWithCredential(
      ["-C", target, "fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      item.credential,
      signal,
    );
    if (fetchResult.code !== 0) throw new Error(fetchResult.stderr || "git fetch 失败");
    // 全量 refspec 下 FETCH_HEAD 含多个分支，不能再用它做合并对象；显式 ff 到跟踪分支的远端引用
    const branch = item.repository.ref ?? (await this.currentBranch(target, signal));
    const merge = await this.runGitWithCredential(
      ["-C", target, "merge", "--ff-only", `refs/remotes/origin/${branch}`],
      undefined,
      signal,
    );
    if (merge.code !== 0) return "远端更新无法 fast-forward，已保留当前版本";
    return undefined;
  }

  /** 本地跟踪分支名（clone 后 HEAD 所指；ref 未配置时的合并目标） */
  private async currentBranch(target: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runGitWithCredential(
      ["-C", target, "symbolic-ref", "--short", "HEAD"],
      undefined,
      signal,
    );
    if (result.code !== 0) throw new Error(result.stderr || "读取当前分支失败");
    return result.stdout.trim();
  }

  /** 把不可识别的已有目录改名备份（保留现场，不删除），再重新克隆到原路径。 */
  private async backupAndReclone(
    target: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
  ): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    let backup = `${target}.stale-${stamp}`;
    for (let i = 2; existsSync(backup); i++) backup = `${target}.stale-${stamp}-${i}`;
    renameSync(target, backup);
    try {
      await this.clone(target, item, signal);
    } catch (error) {
      // 重克隆失败时还原原目录，避免把现场弄丢
      renameSync(backup, target);
      throw error;
    }
    return backup;
  }

  private async runGitWithCredential(
    args: string[],
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitProcessResult> {
    return runGit(args, credential, this.timeoutMs, signal);
  }
}

/** remote URL 指纹比对：容忍 .git 后缀、尾斜杠、大小写与内嵌凭证差异 */
function isSameRemote(localUrl: string, expected: string): boolean {
  const a = normalizeRemoteUrlIdentity(localUrl);
  const b = normalizeRemoteUrlIdentity(expected);
  return a !== "" && a === b;
}

function classifyRemoteFailure(result: GitProcessResult): GitRemoteAccessResult {
  const message = sanitizeGitError(result.stderr || "Git 远端不可访问");
  const lower = message.toLowerCase();
  if (result.timedOut || /timed out|could not resolve|failed to connect|429|5\d\d/.test(lower)) {
    return { ok: false, reason: "provider_unavailable", message };
  }
  if (/not found|repository does not exist/.test(lower)) {
    return { ok: false, reason: "repository_not_found", message };
  }
  return { ok: false, reason: "access_denied", message };
}

function resultFor(
  repository: AgentGitRepository,
  path: string,
  status: RepositoryMaterializeResult["status"],
  message?: string,
): RepositoryMaterializeResult {
  return { repositoryId: repository.id, name: repository.name, path, status, message };
}
