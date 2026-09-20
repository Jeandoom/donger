// git 平台 API 工具（donger-git 的 API 通道）：分支/MR/流水线/文件元数据（只读）
// + 建仓/建分支/建 MR/合并 MR（写）。三平台（jihulab/github/gitee）经 GitPlatformApi
// adapter 分流；凭证按访问者现取（凭证桥），不落 prompt/审计/env（收口防线 1）。
// 仓库定位：repoName → agent 绑定仓库 URL 的 owner/repo；未绑仓库直接给引导错。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createGitPlatformApiResolver } from "../adapters/git-platform-api-resolver.js";
import type { Agent } from "../domain/agent.js";
import { gitPatFromValues } from "../domain/credential.js";
import { type AgentGitRepository, GitProviderSchema, parseRepositoryUrl } from "../domain/git.js";
import type { User } from "../domain/user.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type {
  GitPlatformApi,
  GitPlatformApiResolver,
  PlatformApiResult,
} from "../ports/git-platform-api.js";
import { defaultGitUsername } from "./git-access-gate.js";
import { gitWorkspaceToolDefinitions } from "./git-workspace-tools.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** 输出截断上限：分支/MR 列表与文件原文都可能很大，防单轮 token 爆炸 */
export const MAX_OUTPUT_CHARS = 40_000;

export interface GitPlatformToolsDeps {
  user: User;
  agent: Agent;
  credentialSets?: CredentialSetStore;
  /**
   * 凭证解析身份（凭证桥现取 credentialFor 用）：共享智能体=分享者（属主）id，
   * 缺省回落 user.id。specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §2.5。
   */
  credentialUserId?: string;
  /** 会话仓库工作区根（<runtimeDir>/repos）；CLI 工具通道（git-workspace-tools）依赖 */
  reposRoot?: string;
  /** git 子进程执行器（CLI 工具通道）；缺省 util/git-process.runGit，测试可注入 */
  gitRunner?: typeof import("../util/git-process.js")["runGit"];
  /** 平台 API 客户端解析（三平台内置实现）；测试可注入 */
  platformApis?: GitPlatformApiResolver;
  /** 供测试注入；缺省全局 fetch（透传给缺省平台客户端） */
  fetchImpl?: typeof fetch;
}

export interface RepoTarget {
  repo: AgentGitRepository;
  host: string;
  projectPath: string;
}

export function resolveRepoTarget(agent: Agent, repoName: string): RepoTarget | undefined {
  const repo = agent.gitRepositories.find((item) => item.name === repoName);
  if (!repo) return undefined;
  const parsed = parseRepositoryUrl(repo.url);
  if (!parsed) return undefined;
  return { repo, host: parsed.host, projectPath: parsed.repositoryPath };
}

/** 凭证桥现取：credentialCode → 凭证解析身份（共享智能体=分享者）的 PAT（不落 prompt/审计/env）；username 缺省按平台 */
export async function credentialFor(
  deps: GitPlatformToolsDeps,
  repo: AgentGitRepository,
): Promise<{ username: string; accessToken: string } | undefined> {
  if (!repo.credentialCode || !deps.credentialSets) return undefined;
  const [filled] = await deps.credentialSets.getFilledValues(
    deps.credentialUserId ?? deps.user.id,
    [repo.credentialCode],
  );
  const pat = gitPatFromValues(filled?.values);
  if (!pat) return undefined;
  return {
    username: pat.user || defaultGitUsername(repo.provider),
    accessToken: pat.accessToken,
  };
}

/** 凭证缺失引导文案（引导填写模板值或绑定模板） */
export function credentialMissingHint(repo: AgentGitRepository): string {
  return repo.credentialCode
    ? `请在「我的凭证」填写模板 ${repo.credentialCode} 的值（key: access_token）`
    : `请为仓库 ${repo.name} 绑定凭证模板（credentialCode）`;
}

function platformApiFor(deps: GitPlatformToolsDeps): GitPlatformApiResolver {
  // 测试注入 fetchImpl 时构造带桩客户端的 resolver；否则用全局缺省单例
  return deps.platformApis ?? createGitPlatformApiResolver(deps.fetchImpl);
}

/**
 * 通用前置：解析仓库 → 运行（凭证可选；公共仓库可匿名）。
 * API 工具与 CLI 工具（git-workspace-tools）共用。
 */
export async function withRepo(
  deps: GitPlatformToolsDeps,
  repoName: string,
  run: (
    target: RepoTarget,
    credential?: { username: string; accessToken: string },
  ) => Promise<ToolResult>,
): Promise<ToolResult> {
  const target = resolveRepoTarget(deps.agent, repoName);
  if (!target) {
    const available =
      deps.agent.gitRepositories.map((item) => item.name).join("、") ||
      "（该智能体未绑定任何仓库）";
    return fail(`未找到绑定的仓库「${repoName}」。当前可用：${available}`);
  }
  return run(target, await credentialFor(deps, target.repo));
}

/** API 工具前置：withRepo + token 必须存在（平台 API 调用必需） */
async function withApiTarget(
  deps: GitPlatformToolsDeps,
  repoName: string,
  run: (api: GitPlatformApi, target: RepoTarget, token: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  return withRepo(deps, repoName, async (target, credential) => {
    if (!credential) {
      return fail(`仓库 ${target.repo.name} 缺少访问凭证：${credentialMissingHint(target.repo)}`);
    }
    const api = platformApiFor(deps)(target.repo.provider, target.host);
    if (!api) return fail(`平台 ${target.repo.provider} 暂无 API 工具实现`);
    return run(api, target, credential.accessToken);
  });
}

function toToolResult(result: PlatformApiResult): ToolResult {
  if (!result.ok) return fail(result.body);
  const body =
    result.body.length > MAX_OUTPUT_CHARS
      ? `${result.body.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断）`
      : result.body;
  return ok(body);
}

const RepoNameShape = {
  repoName: z.string().min(1).describe("绑定的仓库目录名（agent gitRepositories 里的 name）"),
};

/** 按平台提取新建仓库的 HTTPS 克隆地址 */
function extractCloneUrl(provider: string, payload: Record<string, unknown>): string | undefined {
  if (provider === "jihulab") {
    return typeof payload.http_url_to_repo === "string" ? payload.http_url_to_repo : undefined;
  }
  if (provider === "github") {
    return typeof payload.clone_url === "string" ? payload.clone_url : undefined;
  }
  return typeof payload.html_url === "string" ? payload.html_url : undefined;
}

/** 绑定仓库型 API 工具的统一装配：入参校验 → withApiTarget → adapter 调用 */
function apiTool(
  deps: GitPlatformToolsDeps,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  call: (
    api: GitPlatformApi,
    ref: { repositoryPath: string },
    token: string,
    args: Record<string, unknown>,
  ) => Promise<PlatformApiResult>,
): SdkMcpToolDefinition {
  return {
    name,
    description,
    inputSchema: shape,
    handler: async (args): Promise<ToolResult> => {
      const a = z.object(shape).parse(args);
      return withApiTarget(deps, a.repoName as string, async (api, target, token) => {
        return toToolResult(await call(api, { repositoryPath: target.projectPath }, token, a));
      });
    },
  };
}

/** 平台 API 工具定义：六个只读元数据 + 四个写操作（导出供单测直调 handler） */
export function gitPlatformToolDefinitions(deps: GitPlatformToolsDeps): SdkMcpToolDefinition[] {
  const mrStates = z.enum(["opened", "merged", "closed"]).optional();
  return [
    apiTool(
      deps,
      "git_platform_list_branches",
      "列出仓库分支（含 merged/protected 等 git CLI 拿不到的平台元数据）。github 不支持 search 过滤",
      {
        ...RepoNameShape,
        search: z.string().optional().describe("分支名模糊过滤（github 忽略）"),
        perPage: z.number().int().min(1).max(100).optional().describe("每页数量（默认 20）"),
      },
      (api, ref, token, a) =>
        api.listBranches(
          {
            ...ref,
            search: a.search as string | undefined,
            perPage: a.perPage as number | undefined,
          },
          token,
        ),
    ),
    apiTool(
      deps,
      "git_platform_get_branch",
      "查询单个分支详情（merged/protected/最新提交）",
      { ...RepoNameShape, branch: z.string().min(1).describe("分支名") },
      (api, ref, token, a) => api.getBranch({ ...ref, branch: a.branch as string }, token),
    ),
    apiTool(
      deps,
      "git_platform_list_mrs",
      "列出合并请求/MR/PR（state: opened/merged/closed，默认 opened；github 的 merged 映射 closed，看响应 merged_at）",
      { ...RepoNameShape, state: mrStates, perPage: z.number().int().min(1).max(100).optional() },
      (api, ref, token, a) =>
        api.listMr(
          {
            ...ref,
            state: a.state as "opened" | "merged" | "closed" | undefined,
            perPage: a.perPage as number | undefined,
          },
          token,
        ),
    ),
    apiTool(
      deps,
      "git_platform_get_mr",
      "查询单个合并请求详情（number=iid/number）",
      { ...RepoNameShape, number: z.string().min(1).describe("MR/PR 编号") },
      (api, ref, token, a) => api.getMr({ ...ref, number: a.number as string }, token),
    ),
    apiTool(
      deps,
      "git_platform_latest_pipeline",
      "查询最新流水线/CI 状态（可按 ref 过滤；github 走 Actions runs，gitee 暂不支持）",
      { ...RepoNameShape, ref: z.string().optional().describe("分支或 tag，缺省取全仓库最新") },
      (api, ref, token, a) =>
        api.latestPipeline({ ...ref, ref: a.ref as string | undefined }, token),
    ),
    apiTool(
      deps,
      "git_platform_get_file_raw",
      "读取仓库单文件原文（未 clone 场景用；支持指定 ref）",
      {
        ...RepoNameShape,
        filePath: z.string().min(1).describe("仓库内路径，如 src/main.py"),
        ref: z.string().optional().describe("分支/tag/commit，缺省仓库默认分支"),
      },
      (api, ref, token, a) =>
        api.getFileRaw(
          { ...ref, filePath: a.filePath as string, ref: a.ref as string | undefined },
          token,
        ),
    ),
    {
      name: "git_create_repo",
      description:
        "在指定平台创建新仓库（当前用户命名空间下；写操作，会弹审批卡确认）。创建后返回 HTTPS 地址，需用户在智能体配置中绑定后方可使用其他 git 工具。",
      inputSchema: {
        provider: GitProviderSchema.describe("平台：github / gitee / jihulab"),
        name: z.string().min(1).max(100).describe("仓库名（当前用户命名空间下）"),
        private: z.boolean().default(true).describe("是否私有（默认私有）"),
        description: z.string().max(500).optional().describe("仓库描述"),
      },
      handler: async (args): Promise<ToolResult> => {
        const a = z
          .object({
            provider: GitProviderSchema,
            name: z.string().min(1).max(100),
            private: z.boolean().default(true),
            description: z.string().max(500).optional(),
          })
          .parse(args);
        const bound = new Set(deps.agent.gitRepositories.map((r) => r.provider));
        if (!bound.has(a.provider)) {
          return fail(
            `平台 ${a.provider} 不在该智能体绑定的平台集合（${[...bound].join("、") || "无"}）内：请先绑定该平台仓库`,
          );
        }
        // git_create_repo 无既定仓库 host：取该方言已绑定仓库的 host（缺省官方域名）
        const boundRepo = deps.agent.gitRepositories.find((r) => r.provider === a.provider);
        const boundHost = boundRepo ? parseRepositoryUrl(boundRepo.url)?.host : undefined;
        const officialHost =
          a.provider === "github"
            ? "github.com"
            : a.provider === "gitee"
              ? "gitee.com"
              : "jihulab.com";
        const api = platformApiFor(deps)(a.provider, boundHost ?? officialHost);
        if (!api) return fail(`平台 ${a.provider} 暂无 API 工具实现`);
        // 建仓凭证取任意同平台绑定仓库的凭证模板（同一平台账号）
        const repo = deps.agent.gitRepositories.find((r) => r.provider === a.provider);
        if (!repo) return fail("未找到同平台绑定仓库");
        const credential = await credentialFor(deps, repo);
        if (!credential) return fail(`缺少该平台访问凭证：${credentialMissingHint(repo)}`);
        const result = await api.createRepo(
          { name: a.name, private: a.private, description: a.description },
          credential.accessToken,
        );
        if (!result.ok) return fail(result.body);
        let cloneUrl = "";
        try {
          cloneUrl = extractCloneUrl(a.provider, JSON.parse(result.body)) ?? "";
        } catch {
          // 响应非 JSON 时只透传原文
        }
        return ok(
          `已创建仓库${cloneUrl ? `：${cloneUrl}` : ""}。请在智能体 Git 配置中绑定该地址后再操作。\n${result.body.slice(0, 2000)}`,
        );
      },
    },
    apiTool(
      deps,
      "git_create_branch",
      "在远端创建分支（写操作，会弹审批卡确认；fromRef 缺省仓库默认分支）",
      {
        ...RepoNameShape,
        branch: z.string().min(1).describe("新分支名"),
        fromRef: z.string().optional().describe("起点分支/tag，缺省默认分支"),
      },
      (api, ref, token, a) =>
        api.createBranch(
          { ...ref, branch: a.branch as string, fromRef: a.fromRef as string | undefined },
          token,
        ),
    ),
    apiTool(
      deps,
      "git_create_mr",
      "创建合并请求/MR/PR（写操作，会弹审批卡确认）",
      {
        ...RepoNameShape,
        source: z.string().min(1).describe("源分支"),
        target: z.string().min(1).describe("目标分支"),
        title: z.string().min(1).max(500).describe("标题"),
        description: z.string().max(10000).optional().describe("描述"),
      },
      (api, ref, token, a) =>
        api.createMr(
          {
            ...ref,
            source: a.source as string,
            target: a.target as string,
            title: a.title as string,
            description: a.description as string | undefined,
          },
          token,
        ),
    ),
    apiTool(
      deps,
      "git_merge_mr",
      "合并指定 MR/PR（写操作，会弹审批卡确认）",
      {
        ...RepoNameShape,
        number: z.string().min(1).describe("MR/PR 编号"),
      },
      (api, ref, token, a) => api.mergeMr({ ...ref, number: a.number as string }, token),
    ),
  ];
}

/** 装配 donger-git SDK MCP server（agent 绑定了 git 仓库时由编排层挂载）：
 * CLI 工作区工具（git-workspace-tools，provider 无关）+ 平台 API 工具（三平台）。 */
export function createGitPlatformToolsServer(
  deps: GitPlatformToolsDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-git",
    version: "1.2.0",
    tools: [...gitWorkspaceToolDefinitions(deps), ...gitPlatformToolDefinitions(deps)],
  });
}
