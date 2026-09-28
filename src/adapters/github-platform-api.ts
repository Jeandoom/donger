// GitHub REST v3 adapter（github.com）。认证：Authorization: Bearer <token>
//（classic 与 fine-grained PAT 均兼容）。注意：branches 无 search 参数（忽略）；
// pulls 的 state 不含 merged（映射 closed，merged 状态看响应 merged_at）；
// 流水线走 Actions runs，响应结构与 GitLab pipelines 不同。

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

export class GitHubPlatformApi implements GitPlatformApi {
  readonly provider: GitProvider = "github";

  constructor(
    private readonly baseUrl = "https://api.github.com",
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  private headers(token: string, accept = "application/vnd.github+json"): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "donger",
    };
  }

  private repo(input: { repositoryPath: string }): string {
    const { owner, repo } = splitRepoPath(input.repositoryPath);
    return `${this.baseUrl}/repos/${owner}/${repo}`;
  }

  async createRepo(input: CreateRepoInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      `${this.baseUrl}/user/repos`,
      "POST",
      this.headers(token),
      {
        name: input.name,
        private: input.private,
        ...(input.description ? { description: input.description } : {}),
      },
      "GitHub",
    );
  }

  async createBranch(input: CreateBranchInput, token: string): Promise<PlatformApiResult> {
    // 起点 commit sha：显式 fromRef → 直接查 ref；缺省 → 仓库默认分支
    let fromRef = input.fromRef;
    if (!fromRef) {
      const meta = await apiGet(this.fetchImpl, this.repo(input), this.headers(token), "GitHub");
      if (!meta.ok) return meta;
      fromRef = (JSON.parse(meta.body) as { default_branch?: string }).default_branch ?? "main";
    }
    const base = await apiGet(
      this.fetchImpl,
      `${this.repo(input)}/git/ref/heads/${encodeURIComponent(fromRef)}`,
      this.headers(token),
      "GitHub",
    );
    if (!base.ok) return base;
    const sha = (JSON.parse(base.body) as { object?: { sha?: string } }).object?.sha;
    if (!sha) return { ok: false, status: base.status, body: "GitHub：未取得起点 commit sha" };
    return apiWrite(
      this.fetchImpl,
      `${this.repo(input)}/git/refs`,
      "POST",
      this.headers(token),
      { ref: `refs/heads/${input.branch}`, sha },
      "GitHub",
    );
  }

  async createMr(input: CreateMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      `${this.repo(input)}/pulls`,
      "POST",
      this.headers(token),
      {
        title: input.title,
        head: input.source,
        base: input.target,
        ...(input.description ? { body: input.description } : {}),
      },
      "GitHub",
    );
  }

  async mergeMr(input: MergeMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      `${this.repo(input)}/pulls/${encodeURIComponent(input.number)}/merge`,
      "PUT",
      this.headers(token),
      { merge_method: "merge" },
      "GitHub",
    );
  }

  async listBranches(input: ListBranchesInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    params.set("per_page", String(input.perPage ?? 20));
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/branches?${params}`,
      this.headers(token),
      "GitHub",
    );
  }

  async getBranch(input: GetBranchInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/branches/${encodeURIComponent(input.branch)}`,
      this.headers(token),
      "GitHub",
    );
  }

  async listMr(input: ListMrInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    // GitHub pulls state 只有 open/closed/all；merged 映射 closed（看响应 merged_at）
    params.set(
      "state",
      input.state === "closed" || input.state === "merged" ? "closed" : (input.state ?? "open"),
    );
    params.set("per_page", String(input.perPage ?? 20));
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/pulls?${params}`,
      this.headers(token),
      "GitHub",
    );
  }

  async getMr(input: GetMrInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/pulls/${encodeURIComponent(input.number)}`,
      this.headers(token),
      "GitHub",
    );
  }

  async latestPipeline(input: LatestPipelineInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    if (input.ref) params.set("branch", input.ref);
    params.set("per_page", "1");
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/actions/runs?${params}`,
      this.headers(token),
      "GitHub",
    );
  }

  async getFileRaw(input: GetFileRawInput, token: string): Promise<PlatformApiResult> {
    const params = new URLSearchParams();
    if (input.ref) params.set("ref", input.ref);
    const suffix = params.toString() ? `?${params}` : "";
    return apiGet(
      this.fetchImpl,
      `${this.repo(input)}/contents/${input.filePath}${suffix}`,
      this.headers(token, "application/vnd.github.raw"),
      "GitHub",
    );
  }
}

export { splitRepoPath };
