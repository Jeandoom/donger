// git 子进程共享封装：materializer（后台物化）与 donger-git CLI 工具（agent 主动操作）
// 共用。AskPass 临时凭证只传给 git 子进程、进程结束即删；错误输出统一脱敏；
// Windows 追加 core.longpaths（aix-py 轮实证长路径缺口）。

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** git HTTP 认证（PAT）：username 缺省按平台（见 git-access-gate.defaultGitUsername） */
export interface GitProcessCredential {
  username: string;
  accessToken: string;
}

/**
 * 执行 git 子进程。参数数组调用、禁止 shell 拼接；GIT_LFS_SKIP_SMUDGE=1、
 * GIT_TERMINAL_PROMPT=0；Windows 追加 `-c core.longpaths=true`。
 */
export function runGitProcess(
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GitProcessResult> {
  const finalArgs = process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error("Git 操作已取消"));
    const child = spawn("git", finalArgs, {
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

/** 高层封装：无凭证直跑；有凭证经临时 AskPass（进程结束删除临时目录） */
export async function runGit(
  args: string[],
  credential?: GitProcessCredential,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<GitProcessResult> {
  if (!credential) return runGitProcess(args, {}, timeoutMs, signal);
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
      timeoutMs,
      signal,
    );
  } finally {
    rmSync(askPass.directory, { recursive: true, force: true });
  }
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

/** 脱敏 git 错误输出：认证 URL、token/password 形态的内容一律打码 */
export function sanitizeGitError(message: string): string {
  return message
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://***@")
    .replace(/(authorization|token|password)[=: ]+[^\s]+/gi, "$1=***")
    .trim()
    .slice(0, 500);
}
