// Gitee API v5 adapter（gitee.com）。认证：access_token 作为 query 参数（v5 惯例，
// 不走认证头）。注意：分支创建用 branch_name/from 参数；v5 无通用流水线 API
//（Gitee Go 未开放通用查询），latestPipeline 返回不支持提示；文件原文接口返回
// base64 content，此处解码为纯文本再透传。

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

export class GiteePlatformApi implements GitPlatformApi {
  readonly provider: GitProvider = "gitee";

  constructor(
    private readonly baseUrl = "https://gitee.com/api/v5",
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  /** v5 认证：access_token 追加为 query 参数 */
  private url(path: string, params: Record<string, string> = {}, token = ""): string {
    const search = new URLSearchParams(params);
    if (token) search.set("access_token", token);
    return `${this.baseUrl}${path}?${search}`;
  }

  private repo(input: { repositoryPath: string }): string {
    const { owner, repo } = splitRepoPath(input.repositoryPath);
    return `/repos/${owner}/${repo}`;
  }

  async createRepo(input: CreateRepoInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.url("/user/repos", {}, token),
      "POST",
      {},
      {
        name: input.name,
        private: input.private,
        ...(input.description ? { description: input.description } : {}),
      },
      "Gitee",
    );
  }

  async createBranch(input: CreateBranchInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.url(`${this.repo(input)}/branches`, {}, token),
      "POST",
      {},
      { branch_name: input.branch, from: input.fromRef ?? "main" },
      "Gitee",
    );
  }

  async createMr(input: CreateMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.url(`${this.repo(input)}/pulls`, {}, token),
      "POST",
      {},
      {
        title: input.title,
        head: input.source,
        base: input.target,
        ...(input.description ? { body: input.description } : {}),
      },
      "Gitee",
    );
  }

  async mergeMr(input: MergeMrInput, token: string): Promise<PlatformApiResult> {
    return apiWrite(
      this.fetchImpl,
      this.url(`${this.repo(input)}/pulls/${encodeURIComponent(input.number)}/merge`, {}, token),
      "PUT",
      {},
      {},
      "Gitee",
    );
  }

  async listBranches(input: ListBranchesInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.url(`${this.repo(input)}/branches`, { per_page: String(input.perPage ?? 20) }, token),
      {},
      "Gitee",
    );
  }

  async getBranch(input: GetBranchInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.url(`${this.repo(input)}/branches/${encodeURIComponent(input.branch)}`, {}, token),
      {},
      "Gitee",
    );
  }

  async listMr(input: ListMrInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.url(
        `${this.repo(input)}/pulls`,
        { state: input.state ?? "opened", per_page: String(input.perPage ?? 20) },
        token,
      ),
      {},
      "Gitee",
    );
  }

  async getMr(input: GetMrInput, token: string): Promise<PlatformApiResult> {
    return apiGet(
      this.fetchImpl,
      this.url(`${this.repo(input)}/pulls/${encodeURIComponent(input.number)}`, {}, token),
      {},
      "Gitee",
    );
  }

  async latestPipeline(_input: LatestPipelineInput, _token: string): Promise<PlatformApiResult> {
    return {
      ok: false,
      status: 0,
      body: "Gitee v5 暂无通用流水线查询 API（Gitee Go 未开放），请到平台网页查看。",
    };
  }

  async getFileRaw(input: GetFileRawInput, token: string): Promise<PlatformApiResult> {
    const params: Record<string, string> = {};
    if (input.ref) params.ref = input.ref;
    const res = await apiGet(
      this.fetchImpl,
      this.url(`${this.repo(input)}/contents/${input.filePath}`, params, token),
      {},
      "Gitee",
    );
    if (!res.ok) return res;
    // v5 contents 返回 JSON {content(base64), encoding}；解码为纯文本便于 agent 直接读
    try {
      const parsed = JSON.parse(res.body) as { content?: string; encoding?: string };
      if (parsed.encoding === "base64" && typeof parsed.content === "string") {
        return {
          ...res,
          body: Buffer.from(parsed.content.replace(/\n/g, ""), "base64").toString("utf8"),
        };
      }
      return res;
    } catch {
      return res;
    }
  }
}

export { splitRepoPath };
