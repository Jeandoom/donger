// git 平台 API 端口：把 donger-git 的平台操作（建仓/建分支/MR/合并/元数据）从
// orchestrator 工具实现里解耦到三平台 adapter（jihulab=GitLab v4 / github=REST v3 /
// gitee=v5）。返回平台原生 JSON 原文（薄封装，agent 自行解读），错误由实现归一为
// ok/status/body 三元组；认证方式差异（PRIVATE-TOKEN / Bearer / access_token 参数）
// 由各实现内部处理。

import type { GitProvider } from "../domain/git.js";

export interface PlatformApiResult {
  ok: boolean;
  status: number;
  /** ok=平台原生 JSON 响应原文；失败=归一后的错误描述（不含 token） */
  body: string;
}

/**
 * 仓库定位：URL 中 host 后的完整路径。
 * GitHub/Gitee 为 owner/repo 两段；GitLab 可能为 group/subgroup/repo 多段（子组），
 * 由各 adapter 自行解释（GitLab 整体 URL-encode 作 project ID）。
 */
export interface RepoRef {
  repositoryPath: string;
}

export interface CreateRepoInput {
  /** 仓库名（首期统一创建在当前用户命名空间下） */
  name: string;
  private: boolean;
  description?: string;
}

export interface CreateBranchInput extends RepoRef {
  branch: string;
  /** 起点分支/tag，缺省仓库默认分支 */
  fromRef?: string;
}

export interface CreateMrInput extends RepoRef {
  source: string;
  target: string;
  title: string;
  description?: string;
}

export interface MergeMrInput extends RepoRef {
  /** MR/PR 编号：GitLab iid / GitHub 与 Gitee number */
  number: string;
}

export interface ListBranchesInput extends RepoRef {
  search?: string;
  perPage?: number;
}

export interface GetBranchInput extends RepoRef {
  branch: string;
}

export type MrState = "opened" | "merged" | "closed";

export interface ListMrInput extends RepoRef {
  state?: MrState;
  perPage?: number;
}

export interface GetMrInput extends RepoRef {
  number: string;
}

export interface LatestPipelineInput extends RepoRef {
  ref?: string;
}

export interface GetFileRawInput extends RepoRef {
  filePath: string;
  ref?: string;
}

export interface GitPlatformApi {
  readonly provider: GitProvider;
  createRepo(input: CreateRepoInput, token: string): Promise<PlatformApiResult>;
  createBranch(input: CreateBranchInput, token: string): Promise<PlatformApiResult>;
  createMr(input: CreateMrInput, token: string): Promise<PlatformApiResult>;
  mergeMr(input: MergeMrInput, token: string): Promise<PlatformApiResult>;
  listBranches(input: ListBranchesInput, token: string): Promise<PlatformApiResult>;
  getBranch(input: GetBranchInput, token: string): Promise<PlatformApiResult>;
  listMr(input: ListMrInput, token: string): Promise<PlatformApiResult>;
  getMr(input: GetMrInput, token: string): Promise<PlatformApiResult>;
  latestPipeline(input: LatestPipelineInput, token: string): Promise<PlatformApiResult>;
  getFileRaw(input: GetFileRawInput, token: string): Promise<PlatformApiResult>;
}

/** provider → 平台 API 客户端（未绑定平台返回 undefined，供工具层过滤） */
export type GitPlatformApiResolver = (provider: GitProvider) => GitPlatformApi | undefined;
