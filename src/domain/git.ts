import { z } from "zod";
import { CREDENTIAL_CODE_PATTERN } from "./credential.js";

export const GitProviderSchema = z.enum(["github", "gitee", "jihulab"]);
export type GitProvider = z.infer<typeof GitProviderSchema>;

const PROVIDER_HOSTS: Record<GitProvider, string> = {
  github: "github.com",
  gitee: "gitee.com",
  jihulab: "jihulab.com",
};

export const AgentGitRepositorySchema = z
  .object({
    id: z.string().min(1),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
      .refine((name) => name !== "." && name !== "..", "仓库目录名非法"),
    provider: GitProviderSchema,
    url: z.string().url(),
    ref: z.string().min(1).max(255).optional(),
    required: z.boolean().default(true),
    shallow: z.boolean().default(true),
    syncMode: z.enum(["cloneOnce", "fastForward"]).default("fastForward"),
    /** 引用凭证模板（私有仓库认证用；保存时自动并入 agent.credentials） */
    credentialCode: z.string().regex(CREDENTIAL_CODE_PATTERN).optional(),
    /** 浅克隆起始时间窗（git --shallow-since，如 "2026-08-01"/"1 year ago"；仅 shallow=true 时生效） */
    shallowSince: z.string().min(1).max(64).optional(),
  })
  .superRefine((repository, ctx) => {
    const parsed = parseRepositoryUrl(repository.url);
    if (!parsed) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "仅支持无凭证的 HTTPS 仓库地址" });
      return;
    }
    // 官方三平台域名自动推断方言并校验；自建 host 合法，方言以用户选择为准
    if (parsed.knownProvider && parsed.knownProvider !== repository.provider) {
      ctx.addIssue({ code: "custom", path: ["provider"], message: "仓库平台与 URL 不匹配" });
    }
  });

export type AgentGitRepository = z.infer<typeof AgentGitRepositorySchema>;

export type GitRemoteFailureReason =
  | "access_denied"
  | "repository_not_found"
  | "provider_unavailable";

export type GitRemoteAccessResult =
  | { ok: true }
  | { ok: false; reason: GitRemoteFailureReason; message: string };

// 平台连接/grant 体系退役后，非公共仓库仅剩凭证桥链路：
// 凭证无效/无权 → access_denied；仓库不存在 / 平台不可用语义不变
export type GitAccessFailureReason = GitRemoteFailureReason;

export interface GitAccessRequirement {
  provider: GitProvider;
  reason: GitAccessFailureReason;
  repositories: Array<{
    id: string;
    name: string;
    fingerprint: string;
  }>;
}

export const AgentGitRepositoriesSchema = z
  .array(AgentGitRepositorySchema)
  .superRefine((repositories, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [index, repository] of repositories.entries()) {
      if (ids.has(repository.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "仓库 id 重复" });
      }
      if (names.has(repository.name.toLowerCase())) {
        ctx.addIssue({ code: "custom", path: [index, "name"], message: "仓库目录名重复" });
      }
      ids.add(repository.id);
      names.add(repository.name.toLowerCase());
    }
  })
  .default([]);

export function inferGitProvider(url: string): GitProvider | undefined {
  return parseRepositoryUrl(url)?.knownProvider;
}

/**
 * URL host → 平台默认 HTTP 认证用户名（PAT 认证；与 git-access-gate.defaultGitUsername
 * 同一映射，供拿不到方言、只有 URL 的链路用：GitLab 系（jihulab/自建）与未知 host 走 oauth2）。
 */
export function defaultUsernameForHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host === "github.com") return "x-access-token";
    if (host === "gitee.com") return "x-token";
  } catch {
    // 非法 URL 落通用缺省
  }
  return "oauth2";
}

/**
 * clone 参数组装（纯函数，便于单测）。
 * shallow=true 走 blobless partial clone（--filter=blob:none）：完整提交历史 + 全部分支，
 * 仅按需拉取文件内容——修复 depth=1 隐含 single-branch 导致「git branch -r 只见单分支、
 * 变更查询误报零变更」的问题（spec 2026-09-12 agent 执行复盘 P0-1）。
 * shallowSince 仍可叠加收窄提交窗口；显式 --no-single-branch 保证窗口模式下不丢其余分支。
 */
export function buildCloneArgs(repository: AgentGitRepository, destination: string): string[] {
  const args = ["clone", "--no-recurse-submodules"];
  if (repository.shallow) {
    args.push("--filter=blob:none", "--no-single-branch");
    if (repository.shallowSince) args.push("--shallow-since", repository.shallowSince);
  }
  if (repository.ref) args.push("--branch", repository.ref);
  args.push(repository.url, destination);
  return args;
}

/**
 * 会话级 worktree 分支前缀（2026-10-14 并行会话分支冲突轮）：每会话在其 worktree
 * 中签出 donger-session/<conversationId> 分支——git 不允许两个 worktree 签出同一
 * 分支，按会话一条分支天然错开，也让会话提交在 worktree 被清理后仍可从分支找回。
 */
export const SESSION_BRANCH_PREFIX = "donger-session/";

/** 归一化仓库标识：host 小写 + path 去 .git 后缀（绑定一致性比对用） */
export function normalizeRepositoryIdentity(value: string): string {
  const parsed = parseRepositoryUrl(value);
  if (!parsed) return "";
  return `${parsed.host.toLowerCase()}/${parsed.repositoryPath.toLowerCase()}`;
}

/**
 * 归一化 git remote URL 指纹（宽松版，物化器 fast-forward 比对用）。
 * 与 normalizeRepositoryIdentity 的差异：容忍 URL 内嵌凭证（oauth2:token@host）、
 * file:// 本地路径与非 https 协议——只比对 host + 仓库路径；完全解析失败时回退原文。
 */
export function normalizeRemoteUrlIdentity(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${url.hostname.toLowerCase()}/${path.toLowerCase()}`;
  } catch {
    return trimmed;
  }
}

/**
 * 绑定一致性校验（纯函数）：仓库级凭证（模板声明 repoUrl）必须与仓库地址归一化相等。
 * 返回错误清单（空 = 通过）；平台级凭证（无 repoUrl）与凭证缺失不在此校验。
 */
export function validateGitCredentialBindings(
  repositories: AgentGitRepository[],
  templateByCode: ReadonlyMap<string, { repoUrl?: string }>,
): string[] {
  const errors: string[] = [];
  for (const repository of repositories) {
    if (!repository.credentialCode) continue;
    const template = templateByCode.get(repository.credentialCode);
    if (!template?.repoUrl) continue;
    const repoIdentity = normalizeRepositoryIdentity(repository.url);
    const credIdentity = normalizeRepositoryIdentity(template.repoUrl);
    if (repoIdentity && credIdentity && repoIdentity !== credIdentity) {
      errors.push(
        `仓库 ${repository.name}（${repository.url}）绑定的凭证 ${repository.credentialCode} 声明的地址是 ${template.repoUrl}，两者不一致`,
      );
    }
  }
  return errors;
}

/** 内网/元数据 host 守门（纯函数）：多用户部署防 SSRF；本地部署可开关放行 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/,
  /^fe80:/,
];
const BLOCKED_DOMAIN_PATTERNS: RegExp[] = [/^metadata\.google\.internal$/];

export function isBlockedHost(host: string, allowPrivate: boolean): boolean {
  if (allowPrivate) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    BLOCKED_HOST_PATTERNS.some((re) => re.test(h)) ||
    BLOCKED_DOMAIN_PATTERNS.some((re) => re.test(h))
  );
}

export function gitRepositoryFingerprint(repository: AgentGitRepository): string {
  const parsed = parseRepositoryUrl(repository.url);
  if (!parsed) {
    throw new Error("仓库 URL 非法");
  }
  return `${parsed.host}/${parsed.repositoryPath}`;
}

export function parseRepositoryUrl(
  value: string,
): { host: string; repositoryPath: string; knownProvider?: GitProvider } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  ) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  // 官方三平台域名仍自动推断 API 方言；其余 host（自建 GitLab/Gitee 私有化/GHE）
  // 合法，方言由用户显式选择（spec 2026-09-10-git-credential-repo-binding §3.2）
  const knownProvider = (Object.keys(PROVIDER_HOSTS) as GitProvider[]).find(
    (candidate) => PROVIDER_HOSTS[candidate] === host,
  );
  const repositoryPath = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (repositoryPath.split("/").filter(Boolean).length < 2) return undefined;
  return { host, repositoryPath, knownProvider };
}

/** 从平台 getBranch 原生 JSON 提取分支 HEAD sha（gitee/github=commit.sha / gitlab=commit.id） */
export function extractBranchHeadSha(provider: string, body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const commit = (payload as { commit?: unknown }).commit;
  if (typeof commit !== "object" || commit === null) return undefined;
  const sha =
    provider === "jihulab" ? (commit as { id?: unknown }).id : (commit as { sha?: unknown }).sha;
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
}

/**
 * 物化失败补救引导（纯函数，2026-10-15 预检去网络化后「已配但失效/私有仓未绑凭证」
 * 的唯一提示位）。入参是 sanitizeGitError 后的 stderr 摘要；网络类瞬时失败不加引导。
 * 「could not read Username」= git 根本没拿到凭证（模板未填值），与
 * 「Authentication failed」= 供了凭证但被远端拒绝，引导动作不同，分开给。
 * 返回可直接拼接在「必需仓库 X 准备失败：…」之后的「；…」片段，无需引导时空串。
 */
export function materializeFailureGuidance(
  message: string,
  repository: AgentGitRepository | undefined,
  shared: boolean,
): string {
  const lower = message.toLowerCase();
  if (/timed out|could not resolve|failed to connect|429|5\d\d/.test(lower)) return "";
  if (/not found|repository does not exist|404/.test(lower)) {
    return "；仓库不存在或已迁移，请检查仓库地址";
  }
  const code = repository?.credentialCode;
  if (/could not read username/.test(lower)) {
    if (!code) return "；该仓库需要访问凭证：请在智能体 Git 配置中为仓库绑定凭证模板";
    return shared
      ? `；缺少凭证：请联系分享者在「我的凭证」填写模板 ${code} 的值（key: access_token）`
      : `；缺少凭证：请在「我的凭证」填写模板 ${code} 的值（key: access_token）`;
  }
  if (code) {
    return shared
      ? `；认证失败：请联系分享者检查「我的凭证」中模板 ${code} 的访问令牌`
      : `；认证失败：请检查「我的凭证」中模板 ${code} 的访问令牌是否有效`;
  }
  return "；该仓库需要访问凭证：请在智能体 Git 配置中为仓库绑定凭证模板";
}
