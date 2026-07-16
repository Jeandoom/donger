import type {
  GitConnection,
  GitConnectionSecrets,
  GitProvider,
  GitRepositoryGrant,
} from "../domain/git.js";

export interface SaveGitConnection {
  id?: string;
  userId: string;
  provider: GitProvider;
  accountId: string;
  accountName: string;
  avatarUrl?: string;
  authType: GitConnection["authType"];
  scopes: string[];
  expiresAt?: string;
  status?: GitConnection["status"];
  accessToken: string;
  refreshToken?: string;
}

export interface GitConnectionStore {
  migrate(): void;
  listByUser(userId: string): Promise<GitConnection[]>;
  get(id: string): Promise<GitConnection | undefined>;
  getDefault(userId: string, provider: GitProvider): Promise<GitConnection | undefined>;
  save(input: SaveGitConnection): Promise<GitConnection>;
  getSecrets(id: string): Promise<GitConnectionSecrets | undefined>;
  delete(id: string, userId: string): Promise<void>;
  saveGrant(grant: GitRepositoryGrant): Promise<void>;
  getGrant(
    userId: string,
    agentId: string,
    repositoryId: string,
  ): Promise<GitRepositoryGrant | undefined>;
}
