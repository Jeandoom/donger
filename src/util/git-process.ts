// git 子进程共享封装：materializer（后台物化）、donger-git CLI 工具（agent 主动操作）、
// 技能同步/技能包安装共用。AskPass 临时凭证只传给 git 子进程、进程结束即删；错误输出统一脱敏；
// Windows 追加 core.longpaths（aix-py 轮实证长路径缺口）。
//
// 认证通道强制（fail-closed，平台只允许 HTTPS + PAT/匿名，见凭证桥）：
// - GIT_SSH/GIT_SSH_COMMAND 指向不存在的命令：任何 SSH 传输（含宿主机全局 insteadOf 改写成
//   ssh://）当场报错，绝不落回宿主机 SSH 公钥；
// - GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS 置空：杜绝终端交互与继承的外部 AskPass 静默供凭；
//   带凭证调用由 runGit 用一次性 AskPass 覆盖；
// - -c credential.helper=：重置凭证助手列表，宿主机 credential.helper（如 GCM manager）
//   不得向「匿名」操作注入存量凭证；
// - 剥离继承的 GIT_CONFIG_COUNT/KEY_n/VALUE_n：外部进程无法经环境变量注入额外 git 配置。
// 其余全局/系统 gitconfig（代理、safe.directory、filter.lfs）保留——部署机网络出依赖它；
// 残余面：全局 insteadOf 若改写成另一 https 地址无法用 -c 复位（部署机现无此类配置）。

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** SSH 通道占位命令：不存在的可执行名——git 一旦尝试 SSH 传输立即报错（绝不静默用公钥） */
const SSH_DISABLED = "donger-git-ssh-disabled";

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
 * 执行 git 子进程。参数数组调用、禁止 shell 拼接；认证通道强制隔离（见文件头）；
 * GIT_LFS_SKIP_SMUDGE=1、GIT_TERMINAL_PROMPT=0；Windows 追加 `-c core.longpaths=true`。
 */
export function runGitProcess(
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GitProcessResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // 剥离外部经 GIT_CONFIG_COUNT 机制注入的配置（可在无配置文件的情况下携带 helper/insteadOf）
    if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_SSH: SSH_DISABLED,
    GIT_SSH_COMMAND: SSH_DISABLED,
    ...extraEnv,
  });
  const finalArgs = [
    "-c",
    "credential.helper=",
    // ext:: 传输会把 URL 余下内容当本机命令执行（gitremote-helpers）；平台只走 https，直接禁死
    "-c",
    "protocol.ext.allow=never",
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    ...args,
  ];
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error("Git 操作已取消"));
    const child = spawn("git", finalArgs, {
      env,
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
