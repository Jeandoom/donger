import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentGitRepository,
  buildCloneArgs,
  type GitRemoteAccessResult,
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
  constructor(private readonly timeoutMs = 120_000) {}

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
      if (!existsSync(target)) await this.clone(target, item, signal);
      else if (item.repository.syncMode === "fastForward") {
        const message = await this.fastForward(target, item, signal);
        if (message) return resultFor(item.repository, target, "warning", message);
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
    if (remote.code !== 0 || remote.stdout.trim() !== item.repository.url) {
      throw new Error("已有目录不是目标仓库，拒绝覆盖");
    }
    const status = await this.runGitWithCredential(
      ["-C", target, "status", "--porcelain"],
      undefined,
      signal,
    );
    if (status.code !== 0) throw new Error(status.stderr || "读取仓库状态失败");
    if (status.stdout.trim()) return "仓库存在本地修改，已跳过自动更新";
    const fetchResult = await this.runGitWithCredential(
      ["-C", target, "fetch", "--no-tags", "origin"],
      item.credential,
      signal,
    );
    if (fetchResult.code !== 0) throw new Error(fetchResult.stderr || "git fetch 失败");
    const merge = await this.runGitWithCredential(
      ["-C", target, "merge", "--ff-only", "FETCH_HEAD"],
      undefined,
      signal,
    );
    if (merge.code !== 0) return "远端更新无法 fast-forward，已保留当前版本";
    return undefined;
  }

  private async runGitWithCredential(
    args: string[],
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitProcessResult> {
    return runGit(args, credential, this.timeoutMs, signal);
  }
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
