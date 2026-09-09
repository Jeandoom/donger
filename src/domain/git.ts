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

export type GitAuthType = "oauth" | "githubApp" | "pat";
export type GitConnectionStatus = "active" | "expired" | "revoked";

export interface GitConnection {
  id: string;
  userId: string;
  provider: GitProvider;
  accountId: string;
  accountName: string;
  avatarUrl?: string;
  authType: GitAuthType;
  scopes: string[];
  expiresAt?: string;
  status: GitConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GitConnectionSecrets {
  accessToken: string;
  refreshToken?: string;
}

export interface GitRepositoryGrant {
  userId: string;
  agentId: string;
  repositoryId: string;
  repositoryFingerprint: string;
  connectionId: string;
  permission: "read" | "write";
  grantedAt: string;
}

export type GitRemoteFailureReason =
  | "access_denied"
  | "repository_not_found"
  | "provider_unavailable";

export type GitRemoteAccessResult =
  | { ok: true }
  | { ok: false; reason: GitRemoteFailureReason; message: string };

export type GitAccessFailureReason =
  | "connection_missing"
  | "token_expired"
  | "token_revoked"
  | "grant_missing"
  | GitRemoteFailureReason;

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

/** clone 参数组装（纯函数，便于单测）：shallow 时可选 shallowSince 收窄历史窗口 */
export function buildCloneArgs(repository: AgentGitRepository, destination: string): string[] {
  const args = ["clone", "--no-recurse-submodules"];
  if (repository.shallow) {
    args.push("--depth", "1");
    if (repository.shallowSince) args.push("--shallow-since", repository.shallowSince);
  }
  if (repository.ref) args.push("--branch", repository.ref);
  args.push(repository.url, destination);
  return args;
}

/** 归一化仓库标识：host 小写 + path 去 .git 后缀（绑定一致性比对用） */
export function normalizeRepositoryIdentity(value: string): string {
  const parsed = parseRepositoryUrl(value);
  if (!parsed) return "";
  return `${parsed.host.toLowerCase()}/${parsed.repositoryPath.toLowerCase()}`;
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
