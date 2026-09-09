// git 平台元数据只读 MCP（donger-git）：GitLab 兼容 API（jihulab）薄封装。
// 定位：git CLI 拿不到的平台元数据（分支 merged/protected、MR、pipeline）与未 clone 场景的单文件读取。
// 凭证按访问者解析：repo.credentialCode → CredentialSetStore 取当前用户 PAT（不落 prompt/审计）；
// host 与 project path 从 agent 绑定的仓库 URL 推导，未绑定仓库的调用直接报引导错。
// GitHub 留接口：resolveRepo 已返回 provider，扩展时在 withTarget 按 provider 分流即可。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Agent } from "../domain/agent.js";
import { type AgentGitRepository, parseRepositoryUrl } from "../domain/git.js";
import type { User } from "../domain/user.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** 输出截断上限：分支/MR 列表与文件原文都可能很大，防单轮 token 爆炸 */
const MAX_OUTPUT_CHARS = 40_000;
const API_TIMEOUT_MS = 15_000;

export interface GitPlatformToolsDeps {
  user: User;
  agent: Agent;
  credentialSets?: CredentialSetStore;
  /** 供测试注入；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

interface RepoTarget {
  repo: AgentGitRepository;
  baseUrl: string;
  projectPath: string;
}

export function resolveRepoTarget(agent: Agent, repoName: string): RepoTarget | undefined {
  const repo = agent.gitRepositories.find((item) => item.name === repoName);
  if (!repo) return undefined;
  const parsed = parseRepositoryUrl(repo.url);
  if (!parsed) return undefined;
  const host = new URL(repo.url).hostname;
  return { repo, baseUrl: `https://${host}/api/v4`, projectPath: parsed.repositoryPath };
}

async function tokenFor(
  deps: GitPlatformToolsDeps,
  repo: AgentGitRepository,
): Promise<string | undefined> {
  if (!repo.credentialCode || !deps.credentialSets) return undefined;
  const [filled] = await deps.credentialSets.getFilledValues(deps.user.id, [repo.credentialCode]);
  return filled?.values.token;
}

/** 统一前置：解析仓库 → 平台白名单 → 凭证现取（含缺失引导文案） */
async function withTarget(
  deps: GitPlatformToolsDeps,
  repoName: string,
  run: (target: RepoTarget, token: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const target = resolveRepoTarget(deps.agent, repoName);
  if (!target) {
    const available =
      deps.agent.gitRepositories.map((item) => item.name).join("、") ||
      "（该智能体未绑定任何仓库）";
    return fail(`未找到绑定的仓库「${repoName}」。当前可用：${available}`);
  }
  if (target.repo.provider !== "jihulab") {
    return fail(
      `git_platform_* 目前仅支持 GitLab 兼容平台（jihulab），仓库 ${target.repo.name} 是 ${target.repo.provider}`,
    );
  }
  const token = await tokenFor(deps, target.repo);
  if (!token) {
    const hint = target.repo.credentialCode
      ? `请在「我的凭证」填写模板 ${target.repo.credentialCode} 的值（key: token）`
      : `请为仓库 ${target.repo.name} 绑定凭证模板（credentialCode）`;
    return fail(`仓库 ${target.repo.name} 缺少访问凭证：${hint}`);
  }
  return run(target, token);
}

async function apiGet(
  deps: GitPlatformToolsDeps,
  target: RepoTarget,
  token: string,
  apiPath: string,
): Promise<ToolResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${target.baseUrl}/projects/${encodeURIComponent(target.projectPath)}${apiPath}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`GitLab API 请求失败：${(e as Error).message}`);
  }
  const body = await res.text();
  if (res.status === 200) {
    return ok(
      body.length > MAX_OUTPUT_CHARS ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断）` : body,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return fail(`GitLab API ${res.status}：凭证无效或权限不足（PAT 需 read_api scope）`);
  }
  if (res.status === 404) {
    return fail(`GitLab API 404：项目或资源不存在（${target.projectPath}）`);
  }
  if (res.status === 429) {
    return fail("GitLab API 429：触发限流，请稍后重试");
  }
  return fail(`GitLab API ${res.status}：${body.slice(0, 500)}`);
}

const RepoNameShape = {
  repoName: z.string().min(1).describe("绑定的仓库目录名（agent gitRepositories 里的 name）"),
};

/** 六个只读工具定义（导出供单测直调 handler） */
export function gitPlatformToolDefinitions(deps: GitPlatformToolsDeps): SdkMcpToolDefinition[] {
  return [
    {
      name: "git_platform_list_branches",
      description: "列出仓库分支（含 merged/protected 等 git CLI 拿不到的平台元数据）",
      inputSchema: {
        ...RepoNameShape,
        search: z.string().optional().describe("分支名模糊过滤"),
        perPage: z.number().int().min(1).max(100).optional().describe("每页数量（默认 20）"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({
            ...RepoNameShape,
            search: z.string().optional(),
            perPage: z.number().optional(),
          })
          .parse(args);
        return withTarget(deps, a.repoName, async (target, token) => {
          const params = new URLSearchParams();
          if (a.search) params.set("search", a.search);
          params.set("per_page", String(a.perPage ?? 20));
          return apiGet(deps, target, token, `/repository/branches?${params.toString()}`);
        });
      },
    },
    {
      name: "git_platform_get_branch",
      description: "查询单个分支详情（merged/protected/最新提交）",
      inputSchema: {
        ...RepoNameShape,
        branch: z.string().min(1).describe("分支名"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...RepoNameShape, branch: z.string() }).parse(args);
        return withTarget(deps, a.repoName, async (target, token) =>
          apiGet(deps, target, token, `/repository/branches/${encodeURIComponent(a.branch)}`),
        );
      },
    },
    {
      name: "git_platform_list_mrs",
      description: "列出合并请求（state: opened/merged/closed，默认 opened）",
      inputSchema: {
        ...RepoNameShape,
        state: z.enum(["opened", "merged", "closed"]).optional(),
        perPage: z.number().int().min(1).max(100).optional(),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({
            ...RepoNameShape,
            state: z.enum(["opened", "merged", "closed"]).optional(),
            perPage: z.number().optional(),
          })
          .parse(args);
        return withTarget(deps, a.repoName, async (target, token) => {
          const params = new URLSearchParams();
          params.set("state", a.state ?? "opened");
          params.set("per_page", String(a.perPage ?? 20));
          return apiGet(deps, target, token, `/merge_requests?${params.toString()}`);
        });
      },
    },
    {
      name: "git_platform_get_mr",
      description: "查询单个合并请求详情",
      inputSchema: {
        ...RepoNameShape,
        iid: z.number().int().min(1).describe("MR 的 iid"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...RepoNameShape, iid: z.number() }).parse(args);
        return withTarget(deps, a.repoName, async (target, token) =>
          apiGet(deps, target, token, `/merge_requests/${a.iid}`),
        );
      },
    },
    {
      name: "git_platform_latest_pipeline",
      description: "查询最新流水线状态（可按 ref 过滤）",
      inputSchema: {
        ...RepoNameShape,
        ref: z.string().optional().describe("分支或 tag，缺省取全仓库最新"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z.object({ ...RepoNameShape, ref: z.string().optional() }).parse(args);
        return withTarget(deps, a.repoName, async (target, token) => {
          const params = new URLSearchParams();
          if (a.ref) params.set("ref", a.ref);
          params.set("per_page", "1");
          return apiGet(deps, target, token, `/pipelines?${params.toString()}`);
        });
      },
    },
    {
      name: "git_platform_get_file_raw",
      description: "读取仓库单文件原文（未 clone 场景用；支持指定 ref）",
      inputSchema: {
        ...RepoNameShape,
        filePath: z.string().min(1).describe("仓库内路径，如 src/main.py"),
        ref: z.string().optional().describe("分支/tag/commit，缺省仓库默认分支"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({ ...RepoNameShape, filePath: z.string(), ref: z.string().optional() })
          .parse(args);
        return withTarget(deps, a.repoName, async (target, token) => {
          const suffix = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : "";
          return apiGet(
            deps,
            target,
            token,
            `/repository/files/${encodeURIComponent(a.filePath)}/raw${suffix}`,
          );
        });
      },
    },
  ];
}

/** 装配 donger-git SDK MCP server（agent 绑定了 git 仓库时由编排层挂载） */
export function createGitPlatformToolsServer(
  deps: GitPlatformToolsDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-git",
    version: "1.0.0",
    tools: gitPlatformToolDefinitions(deps),
  });
}
