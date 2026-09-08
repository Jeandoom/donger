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
    if (parsed.provider !== repository.provider) {
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
  return parseRepositoryUrl(url)?.provider;
}

export function gitRepositoryFingerprint(repository: AgentGitRepository): string {
  const parsed = parseRepositoryUrl(repository.url);
  if (!parsed || parsed.provider !== repository.provider) {
    throw new Error("仓库 URL 与平台不匹配");
  }
  return `${parsed.provider}:${parsed.repositoryPath}`;
}

function parseRepositoryUrl(
  value: string,
): { provider: GitProvider; repositoryPath: string } | undefined {
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
  const provider = (Object.keys(PROVIDER_HOSTS) as GitProvider[]).find(
    (candidate) => PROVIDER_HOSTS[candidate] === url.hostname.toLowerCase(),
  );
  if (!provider) return undefined;
  const repositoryPath = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (repositoryPath.split("/").filter(Boolean).length < 2) return undefined;
  return { provider, repositoryPath };
}
