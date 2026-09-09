// donger-git CLI 工作区工具：agent 对绑定仓库的本地 git 操作唯一通道（clone/fetch/
// pull/status/commit/merge/push）。provider 无关（git CLI 三平台一致）；凭证经凭证桥
// 现取 + 临时 AskPass 注入 git 子进程，不进 env/prompt/返回值（收口防线 1）。
// 工作目录 = 会话仓库工作区 <runtimeDir>/repos/<repoName>，与后台物化共享（同目录收敛）。
// shell git 被 canUseTool 守卫默认禁止（防线 2），本模块是替代面。

import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildCloneArgs } from "../domain/git.js";
import { type GitProcessCredential, runGit, sanitizeGitError } from "../util/git-process.js";
import {
  credentialMissingHint,
  fail,
  type GitPlatformToolsDeps,
  MAX_OUTPUT_CHARS,
  ok,
  type RepoTarget,
  type ToolResult,
  withRepo,
} from "./git-platform-tools.js";

const GIT_TIMEOUT_MS = 120_000;
/** commit 作者固定为 agent 身份：不依赖宿主全局 git config（本地部署常见未配置） */
const COMMIT_IDENTITY = ["-c", "user.name=donger-agent", "-c", "user.email=agent@donger.local"];

const RepoNameShape = {
  repoName: z.string().min(1).describe("绑定的仓库目录名（agent gitRepositories 里的 name）"),
};

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断）` : text;
}

/** 本地子命令统一 `git -C <dir> …`；错误脱敏；超时/异常归一为 ToolResult */
async function execLocal(
  deps: GitPlatformToolsDeps,
  target: RepoTarget,
  credential: GitProcessCredential | undefined,
  subcommand: string[],
): Promise<ToolResult> {
  if (!deps.reposRoot) return fail("会话仓库工作区不可用（reposRoot 未注入）");
  const dir = join(deps.reposRoot, target.repo.name);
  const result = await (deps.gitRunner ?? runGit)(
    ["-C", dir, ...subcommand],
    credential,
    GIT_TIMEOUT_MS,
  ).catch((e: unknown) => ({ code: 1, stdout: "", stderr: (e as Error).message, timedOut: false }));
  if (result.code !== 0) {
    return fail(
      result.timedOut
        ? "git 操作超时（120s）"
        : sanitizeGitError(result.stderr || result.stdout || "git 命令失败"),
    );
  }
  return ok(truncate(result.stdout.trim() || "（成功，无输出）"));
}

export function gitWorkspaceToolDefinitions(deps: GitPlatformToolsDeps): SdkMcpToolDefinition[] {
  return [
    {
      name: "git_clone",
      description:
        "克隆绑定的仓库到会话工作区 repos/<repoName>（幂等：已存在则返回路径提示改用 git_pull）。操作仓库只能用本组 git_* 工具，shell git 已被禁用。",
      inputSchema: RepoNameShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(RepoNameShape).parse(args);
        return withRepo(deps, a.repoName, async (target, credential) => {
          if (!deps.reposRoot) return fail("会话仓库工作区不可用（reposRoot 未注入）");
          const dir = join(deps.reposRoot, target.repo.name);
          if (existsSync(dir)) {
            return fail(`目录已存在：${dir}。如需更新请用 git_pull。`);
          }
          const temporary = `${dir}.clone-${crypto.randomUUID()}`;
          const result = await (deps.gitRunner ?? runGit)(
            buildCloneArgs(target.repo, temporary),
            credential,
            GIT_TIMEOUT_MS,
          ).catch((e: unknown) => ({
            code: 1,
            stdout: "",
            stderr: (e as Error).message,
            timedOut: false,
          }));
          try {
            if (result.code !== 0) {
              return fail(
                result.timedOut
                  ? "git clone 超时（120s）"
                  : sanitizeGitError(result.stderr || "git clone 失败"),
              );
            }
            // 原子落位：clone 成功才改名为正式目录
            renameSync(temporary, dir);
          } finally {
            rmSync(temporary, { recursive: true, force: true });
          }
          return ok(`已克隆到 ${dir}`);
        });
      },
    },
    {
      name: "git_fetch",
      description: "拉取远端更新（fetch origin，不合并工作区）",
      inputSchema: RepoNameShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(RepoNameShape).parse(args);
        return withRepo(deps, a.repoName, (target, credential) =>
          execLocal(deps, target, credential, ["fetch", "--no-tags", "origin"]),
        );
      },
    },
    {
      name: "git_pull",
      description:
        "拉取并合并远端当前分支（strategy=ff 快进 / merge 合并）。工作区有未提交改动时先 git_commit。",
      inputSchema: {
        ...RepoNameShape,
        strategy: z.enum(["ff", "merge"]).default("ff").describe("ff=仅快进；merge=产生合并提交"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...RepoNameShape, strategy: z.enum(["ff", "merge"]).default("ff") })
          .parse(args);
        return withRepo(deps, a.repoName, async (target, credential) => {
          if (!deps.reposRoot) return fail("会话仓库工作区不可用（reposRoot 未注入）");
          const dir = join(deps.reposRoot, target.repo.name);
          const status = await (deps.gitRunner ?? runGit)(
            ["-C", dir, "status", "--porcelain"],
            undefined,
            GIT_TIMEOUT_MS,
          );
          if (status.code !== 0) return fail(sanitizeGitError(status.stderr || "读取仓库状态失败"));
          if (status.stdout.trim()) {
            return fail("工作区有未提交改动，先 git_commit 或撤销后再 pull");
          }
          const fetched = await execLocal(deps, target, credential, [
            "fetch",
            "--no-tags",
            "origin",
          ]);
          if (fetched.isError) return fetched;
          const merged = await execLocal(deps, target, undefined, [
            "merge",
            ...(a.strategy === "ff" ? ["--ff-only"] : []),
            "FETCH_HEAD",
          ]);
          if (merged.isError && a.strategy === "ff") {
            return fail(
              `无法快进（远端历史分叉？）可用 strategy=merge：${merged.content[0]?.text}`,
            );
          }
          return merged;
        });
      },
    },
    {
      name: "git_status",
      description: "查看工作区状态（分支、领先/落后、改动文件清单）",
      inputSchema: RepoNameShape,
      handler: async (args): Promise<ToolResult> => {
        const a = z.object(RepoNameShape).parse(args);
        return withRepo(deps, a.repoName, (target) =>
          execLocal(deps, target, undefined, ["status", "--porcelain", "-b"]),
        );
      },
    },
    {
      name: "git_commit",
      description:
        "提交工作区改动（作者 donger-agent）。addAll=true 时先暂存全部改动；无改动时报错。",
      inputSchema: {
        ...RepoNameShape,
        message: z.string().min(1).max(2000).describe("提交信息"),
        addAll: z.boolean().default(true).describe("是否先暂存全部改动（git add -A）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({
            ...RepoNameShape,
            message: z.string().min(1).max(2000),
            addAll: z.boolean().default(true),
          })
          .parse(args);
        return withRepo(deps, a.repoName, async (target) => {
          if (!deps.reposRoot) return fail("会话仓库工作区不可用（reposRoot 未注入）");
          const dir = join(deps.reposRoot, target.repo.name);
          if (a.addAll) await execLocal(deps, target, undefined, ["add", "-A"]);
          // git diff --cached --quiet：暂存区有差异退出码 1，无差异 0
          const diff = await (deps.gitRunner ?? runGit)(
            ["-C", dir, "diff", "--cached", "--quiet"],
            undefined,
            GIT_TIMEOUT_MS,
          );
          if (diff.code === 0) return fail("工作区没有可提交的改动（暂存区为空）");
          return execLocal(deps, target, undefined, [
            ...COMMIT_IDENTITY,
            "commit",
            "-m",
            a.message,
          ]);
        });
      },
    },
    {
      name: "git_merge",
      description: "将 sourceBranch 合并进当前分支（冲突时透传 git 提示）",
      inputSchema: {
        ...RepoNameShape,
        sourceBranch: z.string().min(1).describe("要合并进来的分支名"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...RepoNameShape, sourceBranch: z.string().min(1) }).parse(args);
        return withRepo(deps, a.repoName, (target) =>
          execLocal(deps, target, undefined, ["merge", a.sourceBranch]),
        );
      },
    },
    {
      name: "git_push",
      description:
        "推送当前 HEAD 到远端分支 origin/<branch>（写操作，会弹审批卡确认）。force 仅在明确被要求时使用。",
      inputSchema: {
        ...RepoNameShape,
        branch: z.string().min(1).describe("目标远端分支名"),
        force: z.boolean().default(false).describe("强制推送（覆盖远端历史，慎用）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({
            ...RepoNameShape,
            branch: z.string().min(1),
            force: z.boolean().default(false),
          })
          .parse(args);
        return withRepo(deps, a.repoName, async (target, credential) => {
          // 匿名 push 永远失败：缺凭证直接引导，不走无意义命令
          if (!credential) {
            return fail(`git_push 需要仓库写权限：${credentialMissingHint(target.repo)}`);
          }
          return execLocal(deps, target, credential, [
            "push",
            ...(a.force ? ["--force"] : []),
            "origin",
            `HEAD:refs/heads/${a.branch}`,
          ]);
        });
      },
    },
  ];
}
