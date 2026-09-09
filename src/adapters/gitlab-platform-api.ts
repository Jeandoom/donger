// GitLab 兼容平台（jihulab.com）API v4 adapter。认证：PRIVATE-TOKEN 头。
// 参考文档 https://docs.gitlab.cn/je/docs/api/ （极狐兼容 GitLab v4）。

import type { GitProvider } from "../domain/git.js";
import type {
  CreateBranchInput,
  CreateMrInput,
  CreateRepoInput,
  GetBranchInput,
  GetFileRawInput,
  GetMrInput,
  GitPlatformApi,
  LatestPipelineInput,
  ListBranchesInput,
  ListMrInput,
  MergeMrInput,
  PlatformApiResult,
} from "../ports/git-platform-api.js";
import { apiGet, apiWrite, type FetchImpl, splitRepoPath } from "./git-platform-api-shared.js";

export class GitLabPlatformApi implements GitPlatformApi {
  readonly provider: GitProvider = "jihulab";

  constructor(
    private readonly baseUrl = "https://jihulab.com/api/v4",
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  private headers(token: string): Record<string, string> {
    return { "PRIVATE-TOKEN": token };
  }

  private projectUrl(repositoryPath: string, suffix: string): string {
    return `${this.baseUrl}/projects/${encodeURIComponent(repositoryPath)}${suffix}`;
  }

  private ref(input: { repositoryPath: string }): string {
    return input.repositoryPath;
  }

  async createRepo(input: CreateRepoInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      `${this.baseUrl}/projects`,
      "POST",
      this.headers(token),
      {
        name: input.name,
        visibility: input.private ? "private" : "public",
        ...(input.description ? { description: input.description } : {}),
      },
      "GitLab",
    );
  }

  async createBranch(input: CreateBranchInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, "/repository/branches"),
      "POST",
      this.headers(token),
      { branch: input.branch, ref: input.fromRef ?? "main" },
      "GitLab",
    );
  }

  async createMr(input: CreateMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, "/merge_requests"),
      "POST",
      this.headers(token),
      {
        source_branch: input.source,
        target_branch: input.target,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      },
      "GitLab",
    );
  }

  async mergeMr(input: MergeMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.projectUrl(
        `${this.ref(input)}`,
        `/merge_requests/${encodeURIComponent(input.number)}/merge`,
      ),
      "PUT",
      this.headers(token),
      {},
      "GitLab",
    );
  }

  async listBranches(input: ListBranchesInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    if (input.search) params.set("search", input.search);
    params.set("per_page", String(input.perPage ?? 20));
    return apiGet(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, `/repository/branches?${params}`),
      this.headers(token),
      "GitLab",
    );
  }

  async getBranch(input: GetBranchInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.projectUrl(
        `${this.ref(input)}`,
        `/repository/branches/${encodeURIComponent(input.branch)}`,
      ),
      this.headers(token),
      "GitLab",
    );
  }

  async listMr(input: ListMrInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    params.set("state", input.state ?? "opened");
    params.set("per_page", String(input.perPage ?? 20));
    return apiGet(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, `/merge_requests?${params}`),
      this.headers(token),
      "GitLab",
    );
  }

  async getMr(input: GetMrInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, `/merge_requests/${encodeURIComponent(input.number)}`),
      this.headers(token),
      "GitLab",
    );
  }

  async latestPipeline(input: LatestPipelineInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    if (input.ref) params.set("ref", input.ref);
    params.set("per_page", "1");
    return apiGet(
      this.fetchImpl,
      this.projectUrl(`${this.ref(input)}`, `/pipelines?${params}`),
      this.headers(token),
      "GitLab",
    );
  }

  async getFileRaw(input: GetFileRawInput, token: string): Promise<PlatformApiResult> {
    const suffix = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    return apiGet(
      this.fetchImpl,
      this.projectUrl(
        `${this.ref(input)}`,
        `/repository/files/${encodeURIComponent(input.filePath)}/raw${suffix}`,
      ),
      this.headers(token),
      "GitLab",
    );
  }
}

export { splitRepoPath };
