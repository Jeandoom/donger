import type { AgentGitRepository, GitRemoteAccessResult } from "../domain/git.js";

export interface GitProcessCredential {
  username: string;
  accessToken: string;
}

export interface RepositoryMaterializeItem {
  repository: AgentGitRepository;
  credential?: GitProcessCredential;
}

/**
 * 会话级隔离参数（2026-10-14 并行会话分支冲突轮）：提供时每个仓库在主克隆之外
 * 额外物化为 `<worktreeRoot>/<conversationId>/repos/<name>` 的 git worktree，
 * 会话在私有工作树里干活，主克隆只作同步基座。缺省=旧行为（共享目录）。
 */
export interface RepositorySessionScope {
  conversationId: string;
  /** 会话 worktree 根（<runtimeDir>/worktrees） */
  worktreeRoot: string;
  /**
   * 分叉会话（specs/2026-10-23-conversation-fork-design.md §6）：基点改指源会话——优先
   * 源工作树零扰动快照（携带未提交变更，D3 拍板），回退源会话分支，再回退标准基点。
   */
  forkSource?: { conversationId: string };
}

export interface RepositoryMaterializeRequest {
  destination: string;
  items: RepositoryMaterializeItem[];
  signal?: AbortSignal;
  session?: RepositorySessionScope;
}

export interface RepositoryMaterializeResult {
  repositoryId: string;
  name: string;
  path: string;
  status: "ready" | "warning" | "error";
  message?: string;
}

export interface RepositoryMaterializer {
  checkRead(
    repository: AgentGitRepository,
    credential?: GitProcessCredential,
    signal?: AbortSignal,
  ): Promise<GitRemoteAccessResult>;
  materialize(request: RepositoryMaterializeRequest): Promise<RepositoryMaterializeResult[]>;
}
