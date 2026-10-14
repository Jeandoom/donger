import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentGitRepository,
  buildCloneArgs,
  type GitRemoteAccessResult,
  normalizeRemoteUrlIdentity,
  SESSION_BRANCH_PREFIX,
} from "../domain/git.js";
import type {
  GitProcessCredential,
  RepositoryMaterializeItem,
  RepositoryMaterializeRequest,
  RepositoryMaterializeResult,
  RepositoryMaterializer,
  RepositorySessionScope,
} from "../ports/repository-materializer.js";
import type { GitProcessResult } from "../util/git-process.js";
import { runGit, sanitizeGitError } from "../util/git-process.js";

/** 会话 worktree 的 repos 区根：<worktreeRoot>/<conversationId>/repos */
export function sessionWorktreeReposRoot(worktreeRoot: string, conversationId: string): string {
  return join(worktreeRoot, conversationId, "repos");
}

/** 会话分支名（conversationId 中不合法的分支字符归一为 "-"，平台生成的 UUID 不受影响） */
export function sessionBranchFor(conversationId: string): string {
  return SESSION_BRANCH_PREFIX + conversationId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

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
      results.push(await this.materializeOne(destination, item, request.signal, request.session));
    }
    return results;
  }

  private async materializeOne(
    destination: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
    session?: RepositorySessionScope,
  ): Promise<RepositoryMaterializeResult> {
    const target = join(destination, item.repository.name);
    try {
      let warning: string | undefined;
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
          warning = await this.fastForward(target, item, signal);
          this.lastSyncAt.set(target, this.now());
        }
      }
      if (!session) {
        return warning
          ? resultFor(item.repository, target, "warning", warning)
          : resultFor(item.repository, target, "ready");
      }
      // warning（如 ff 失败/脏基座跳过合并）不阻断会话 worktree：基座已就绪即可供 worktree
      const wtPath = await this.ensureSessionWorktree(target, item, session, signal);
      return warning
        ? resultFor(item.repository, wtPath, "warning", warning)
        : resultFor(item.repository, wtPath, "ready");
    } catch (error) {
      return resultFor(
        item.repository,
        session
          ? sessionWorktreeReposRoot(session.worktreeRoot, session.conversationId) +
              "/" +
              item.repository.name
          : target,
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
    // fetch 前置于脏检查（2026-10-14 并行会话分支冲突轮）：会话隔离模式下主克隆只是同步
    // 基座，agent 遗留的脏树不应阻断远端引用更新——只跳过 merge，worktree 仍基于最新
    // origin 引用创建。显式全量 refspec：旧的单分支浅克隆（--depth 1 隐含 single-branch）
    // 也能在此补齐全部分支引用（2026-09-12 复盘 P0-1）。
    const fetchResult = await this.runGitWithCredential(
      ["-C", target, "fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      item.credential,
      signal,
    );
    if (fetchResult.code !== 0) throw new Error(fetchResult.stderr || "git fetch 失败");
    const status = await this.runGitWithCredential(
      ["-C", target, "status", "--porcelain"],
      undefined,
      signal,
    );
    if (status.code !== 0) throw new Error(status.stderr || "读取仓库状态失败");
    if (status.stdout.trim()) return "仓库存在本地修改，已跳过自动更新";
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

  /**
   * 确保会话私有 worktree 存在并指向本仓库主克隆，返回其路径（幂等）。
   * - 已存在且 .git-common-dir 指向本主克隆 → 复用；
   * - 存在但无效/异源 → 改名 .stale-* 备份后重建（不删现场）；
   * - 不存在 → 基于 origin/<主分支> 新建 donger-session/<convId> 分支；分支残留则重挂
   *   （保留该会话历史提交）；注册残留先 prune 重试。
   */
  private async ensureSessionWorktree(
    mainClone: string,
    item: RepositoryMaterializeItem,
    session: RepositorySessionScope,
    signal?: AbortSignal,
  ): Promise<string> {
    const wtReposRoot = sessionWorktreeReposRoot(session.worktreeRoot, session.conversationId);
    mkdirSync(wtReposRoot, { recursive: true });
    const wtPath = join(wtReposRoot, item.repository.name);
    const branch = sessionBranchFor(session.conversationId);
    if (existsSync(wtPath)) {
      const commonDir = await this.runGitWithCredential(
        ["-C", wtPath, "rev-parse", "--git-common-dir"],
        undefined,
        signal,
      );
      const expectedCommon = resolve(join(mainClone, ".git"));
      const actualCommon = commonDir.code === 0 ? resolve(wtPath, commonDir.stdout.trim()) : "";
      if (actualCommon === expectedCommon) return wtPath;
      await this.backupDirAside(wtPath);
    }
    const base = await this.resolveBaseRef(mainClone, item, signal);
    let added = await this.runGitWithCredential(
      ["-C", mainClone, "worktree", "add", "-b", branch, wtPath, base.ref],
      undefined,
      signal,
    );
    if (added.code !== 0) {
      // 失效注册（目录被手动清理/改名过）先 prune；分支残留（worktree 曾被 GC 但分支
      // 保留）则重挂既有分支，会话历史提交不丢。
      await this.runGitWithCredential(["-C", mainClone, "worktree", "prune"], undefined, signal);
      added = await this.runGitWithCredential(
        ["-C", mainClone, "worktree", "add", wtPath, branch],
        undefined,
        signal,
      );
    }
    if (added.code !== 0) {
      throw new Error(sanitizeGitError(added.stderr || "git worktree add 失败"));
    }
    if (base.upstream) {
      // upstream 指向主分支：git_pull/git_status 的「落后/领先」即相对主分支
      await this.runGitWithCredential(
        ["-C", mainClone, "branch", `--set-upstream-to=${base.upstream}`, branch],
        undefined,
        signal,
      );
    }
    return wtPath;
  }

  /** worktree 基点：repository.ref → origin/HEAD → 主克隆当前分支的远端引用；全部缺失回退 HEAD */
  private async resolveBaseRef(
    mainClone: string,
    item: RepositoryMaterializeItem,
    signal?: AbortSignal,
  ): Promise<{ ref: string; upstream?: string }> {
    const candidates: Array<{ ref: string; upstream?: string }> = [];
    if (item.repository.ref) {
      candidates.push({
        ref: `refs/remotes/origin/${item.repository.ref}`,
        upstream: `origin/${item.repository.ref}`,
      });
    } else {
      const originHead = await this.runGitWithCredential(
        ["-C", mainClone, "symbolic-ref", "refs/remotes/origin/HEAD"],
        undefined,
        signal,
      );
      const ref = originHead.stdout.trim();
      if (originHead.code === 0 && ref.startsWith("refs/remotes/")) {
        candidates.push({ ref, upstream: ref.replace(/^refs\/remotes\//, "") });
      } else {
        const cur = await this.currentBranch(mainClone, signal);
        candidates.push({ ref: `refs/remotes/origin/${cur}`, upstream: `origin/${cur}` });
      }
    }
    for (const candidate of candidates) {
      const verify = await this.runGitWithCredential(
        ["-C", mainClone, "rev-parse", "--verify", `${candidate.ref}^{commit}`],
        undefined,
        signal,
      );
      if (verify.code === 0) return candidate;
    }
    return { ref: "HEAD" };
  }

  /** 把现场改名备份（保留，不删除），返回备份路径 */
  private async backupDirAside(path: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    let backup = `${path}.stale-${stamp}`;
    for (let i = 2; existsSync(backup); i++) backup = `${path}.stale-${stamp}-${i}`;
    renameSync(path, backup);
    return backup;
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
    const backup = await this.backupDirAside(target);
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
