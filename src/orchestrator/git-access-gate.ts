import type { Agent } from "../domain/agent.js";
import {
  type AgentGitRepository,
  type GitAccessFailureReason,
  type GitAccessRequirement,
  type GitConnection,
  gitRepositoryFingerprint,
} from "../domain/git.js";
import type { User } from "../domain/user.js";
import type { GitConnectionStore } from "../ports/git-connection-store.js";
import type {
  GitProcessCredential,
  RepositoryMaterializeItem,
  RepositoryMaterializer,
} from "../ports/repository-materializer.js";

export interface GitAccessCheck {
  ready: boolean;
  requirements: GitAccessRequirement[];
  materializeItems: RepositoryMaterializeItem[];
}

export class GitAccessGate {
  private readonly anonymousCache = new Map<string, { public: boolean; expiresAt: number }>();
  private readonly authorizedCache = new Map<string, number>();

  constructor(
    private readonly connections: GitConnectionStore,
    private readonly materializer: RepositoryMaterializer,
    private readonly cacheTtlMs = 600_000,
  ) {}

  async check(user: User, agent: Agent, signal?: AbortSignal): Promise<GitAccessCheck> {
    const failures: Array<{
      repository: AgentGitRepository;
      fingerprint: string;
      reason: GitAccessFailureReason;
    }> = [];
    const materializeItems: RepositoryMaterializeItem[] = [];
    for (const repository of agent.gitRepositories) {
      const fingerprint = gitRepositoryFingerprint(repository);
      if (await this.isPublic(repository, fingerprint, signal)) {
        materializeItems.push({ repository });
        continue;
      }
      const authorized = await this.checkPrivate(user, agent, repository, fingerprint, signal);
      if ("reason" in authorized)
        failures.push({ repository, fingerprint, reason: authorized.reason });
      else materializeItems.push({ repository, credential: authorized.credential });
    }
    const requirements = groupRequirements(failures);
    return { ready: requirements.length === 0, requirements, materializeItems };
  }

  async grantRepositories(
    user: User,
    agent: Agent,
    repositoryIds: string[],
    signal?: AbortSignal,
  ): Promise<GitAccessCheck> {
    const selected = new Set(repositoryIds);
    for (const repository of agent.gitRepositories.filter((item) => selected.has(item.id))) {
      const connection = await this.connections.getDefault(user.id, repository.provider);
      if (!connection) throw new Error(`${repository.provider} 尚未授权`);
      const secrets = await this.connections.getSecrets(connection.id);
      if (!secrets) throw new Error(`${repository.provider} 授权凭证不存在`);
      const credential = credentialFor(connection, secrets.accessToken);
      const access = await this.materializer.checkRead(repository, credential, signal);
      if (!access.ok) throw new Error(access.message);
      await this.connections.saveGrant({
        userId: user.id,
        agentId: agent.id,
        repositoryId: repository.id,
        repositoryFingerprint: gitRepositoryFingerprint(repository),
        connectionId: connection.id,
        permission: "read",
        grantedAt: new Date().toISOString(),
      });
    }
    return this.check(user, agent, signal);
  }

  private async isPublic(
    repository: AgentGitRepository,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const cached = this.anonymousCache.get(fingerprint);
    if (cached && cached.expiresAt > Date.now()) return cached.public;
    const access = await this.materializer.checkRead(repository, undefined, signal);
    const isPublic = access.ok;
    this.anonymousCache.set(fingerprint, {
      public: isPublic,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return isPublic;
  }

  private async checkPrivate(
    user: User,
    agent: Agent,
    repository: AgentGitRepository,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<{ credential: GitProcessCredential } | { reason: GitAccessFailureReason }> {
    const connection = await this.connections.getDefault(user.id, repository.provider);
    if (!connection) return { reason: "connection_missing" };
    if (connection.status === "revoked") return { reason: "token_revoked" };
    if (connection.status === "expired" || isExpired(connection))
      return { reason: "token_expired" };
    const grant = await this.connections.getGrant(user.id, agent.id, repository.id);
    if (
      !grant ||
      grant.repositoryFingerprint !== fingerprint ||
      grant.connectionId !== connection.id
    ) {
      return { reason: "grant_missing" };
    }
    const secrets = await this.connections.getSecrets(connection.id);
    if (!secrets) return { reason: "token_revoked" };
    const credential = credentialFor(connection, secrets.accessToken);
    const cacheKey = `${user.id}:${agent.id}:${repository.id}:${fingerprint}:${connection.id}`;
    if ((this.authorizedCache.get(cacheKey) ?? 0) > Date.now()) return { credential };
    const access = await this.materializer.checkRead(repository, credential, signal);
    if (!access.ok) return { reason: access.reason };
    this.authorizedCache.set(cacheKey, Date.now() + this.cacheTtlMs);
    return { credential };
  }
}

function isExpired(connection: GitConnection): boolean {
  return Boolean(connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now());
}

function credentialFor(connection: GitConnection, accessToken: string): GitProcessCredential {
  const username =
    connection.provider === "github"
      ? "x-access-token"
      : connection.provider === "jihulab"
        ? "oauth2"
        : connection.accountName;
  return { username, accessToken };
}

function groupRequirements(
  failures: Array<{
    repository: AgentGitRepository;
    fingerprint: string;
    reason: GitAccessFailureReason;
  }>,
): GitAccessRequirement[] {
  const groups = new Map<string, GitAccessRequirement>();
  for (const failure of failures) {
    const key = `${failure.repository.provider}:${failure.reason}`;
    const group = groups.get(key) ?? {
      provider: failure.repository.provider,
      reason: failure.reason,
      repositories: [],
    };
    group.repositories.push({
      id: failure.repository.id,
      name: failure.repository.name,
      fingerprint: failure.fingerprint,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}
