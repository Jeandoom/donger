import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentGitRepository, GitRemoteAccessResult } from "../domain/git.js";
import type {
  GitProcessCredential,
  RepositoryMaterializeItem,
  RepositoryMaterializeRequest,
  RepositoryMaterializeResult,
  RepositoryMaterializer,
} from "../ports/repository-materializer.js";

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class GitCliRepositoryMaterializer implements RepositoryMaterializer {
  constructor(private readonly timeoutMs = 120_000) {}

  async checkRead(
    repository: AgentGitRepository,
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitRemoteAccessResult> {
    const result = await this.runGit(["ls-remote", repository.url, "HEAD"], credential, signal);
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
    const args = ["clone", "--no-recurse-submodules"];
    if (item.repository.shallow) args.push("--depth", "1");
    if (item.repository.ref) args.push("--branch", item.repository.ref);
    args.push(item.repository.url, temporary);
    try {
      const result = await this.runGit(args, item.credential, signal);
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
    const remote = await this.runGit(
      ["-C", target, "remote", "get-url", "origin"],
      undefined,
      signal,
    );
    if (remote.code !== 0 || remote.stdout.trim() !== item.repository.url) {
      throw new Error("已有目录不是目标仓库，拒绝覆盖");
    }
    const status = await this.runGit(["-C", target, "status", "--porcelain"], undefined, signal);
    if (status.code !== 0) throw new Error(status.stderr || "读取仓库状态失败");
    if (status.stdout.trim()) return "仓库存在本地修改，已跳过自动更新";
    const fetchResult = await this.runGit(
      ["-C", target, "fetch", "--no-tags", "origin"],
      item.credential,
      signal,
    );
    if (fetchResult.code !== 0) throw new Error(fetchResult.stderr || "git fetch 失败");
    const merge = await this.runGit(
      ["-C", target, "merge", "--ff-only", "FETCH_HEAD"],
      undefined,
      signal,
    );
    if (merge.code !== 0) return "远端更新无法 fast-forward，已保留当前版本";
    return undefined;
  }

  private async runGit(
    args: string[],
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    if (!credential) return runGitProcess(args, {}, this.timeoutMs, signal);
    const askPass = createAskPass();
    try {
      return await runGitProcess(
        args,
        {
          GIT_ASKPASS: askPass.path,
          GIT_TERMINAL_PROMPT: "0",
          DONGER_GIT_USERNAME: credential.username,
          DONGER_GIT_PASSWORD: credential.accessToken,
        },
        this.timeoutMs,
        signal,
      );
    } finally {
      rmSync(askPass.directory, { recursive: true, force: true });
    }
  }
}

function runGitProcess(
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error("Git 操作已取消"));
    const child = spawn("git", args, {
      env: { ...process.env, ...extraEnv, GIT_LFS_SKIP_SMUDGE: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function createAskPass(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "donger-git-askpass-"));
  const isWindows = process.platform === "win32";
  const path = join(directory, isWindows ? "askpass.cmd" : "askpass.sh");
  const content = isWindows
    ? "@echo off\r\necho %1 | findstr /I username >nul && (echo %DONGER_GIT_USERNAME%) || (echo %DONGER_GIT_PASSWORD%)\r\n"
    : '#!/bin/sh\ncase "$1" in *sername*) printf \'%s\\n\' "$DONGER_GIT_USERNAME" ;; *) printf \'%s\\n\' "$DONGER_GIT_PASSWORD" ;; esac\n';
  writeFileSync(path, content, { encoding: "utf8", mode: 0o700 });
  if (!isWindows) chmodSync(path, 0o700);
  return { directory, path };
}

function classifyRemoteFailure(result: GitCommandResult): GitRemoteAccessResult {
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

function sanitizeGitError(message: string): string {
  return message
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://***@")
    .replace(/(authorization|token|password)[=: ]+[^\s]+/gi, "$1=***")
    .trim()
    .slice(0, 500);
}

function resultFor(
  repository: AgentGitRepository,
  path: string,
  status: RepositoryMaterializeResult["status"],
  message?: string,
): RepositoryMaterializeResult {
  return { repositoryId: repository.id, name: repository.name, path, status, message };
}
