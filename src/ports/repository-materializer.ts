import type { AgentGitRepository, GitRemoteAccessResult } from "../domain/git.js";

export interface GitProcessCredential {
  username: string;
  accessToken: string;
}

export interface RepositoryMaterializeItem {
  repository: AgentGitRepository;
  credential?: GitProcessCredential;
}

export interface RepositoryMaterializeRequest {
  destination: string;
  items: RepositoryMaterializeItem[];
  signal?: AbortSignal;
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
