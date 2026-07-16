import type { Database } from "better-sqlite3";
import type {
  GitConnection,
  GitConnectionSecrets,
  GitProvider,
  GitRepositoryGrant,
} from "../domain/git.js";
import type { GitConnectionStore, SaveGitConnection } from "../ports/git-connection-store.js";
import type { SecretCipher } from "../util/secret-cipher.js";

interface ConnectionRow {
  id: string;
  userId: string;
  provider: GitProvider;
  data: string;
  accessToken: string;
  refreshToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SqliteGitConnectionStore implements GitConnectionStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS git_connections (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        provider TEXT NOT NULL,
        data TEXT NOT NULL,
        accessToken TEXT NOT NULL,
        refreshToken TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_git_connections_user_provider
        ON git_connections(userId, provider);
      CREATE TABLE IF NOT EXISTS git_repository_grants (
        userId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        repositoryId TEXT NOT NULL,
        repositoryFingerprint TEXT NOT NULL,
        connectionId TEXT NOT NULL,
        permission TEXT NOT NULL,
        grantedAt TEXT NOT NULL,
        PRIMARY KEY (userId, agentId, repositoryId)
      );
    `);
  }

  async listByUser(userId: string): Promise<GitConnection[]> {
    const rows = this.db
      .prepare("SELECT * FROM git_connections WHERE userId = ? ORDER BY updatedAt DESC")
      .all(userId) as ConnectionRow[];
    return rows.map((row) => this.toConnection(row));
  }

  async get(id: string): Promise<GitConnection | undefined> {
    const row = this.db.prepare("SELECT * FROM git_connections WHERE id = ?").get(id) as
      | ConnectionRow
      | undefined;
    return row ? this.toConnection(row) : undefined;
  }

  async getDefault(userId: string, provider: GitProvider): Promise<GitConnection | undefined> {
    const row = this.db
      .prepare(
        "SELECT * FROM git_connections WHERE userId = ? AND provider = ? ORDER BY updatedAt DESC LIMIT 1",
      )
      .get(userId, provider) as ConnectionRow | undefined;
    return row ? this.toConnection(row) : undefined;
  }

  async save(input: SaveGitConnection): Promise<GitConnection> {
    const existing = input.id ? ((await this.get(input.id)) ?? undefined) : undefined;
    if (existing && existing.userId !== input.userId) throw new Error("Git 连接不属于当前用户");
    const now = new Date().toISOString();
    const connection: GitConnection = {
      id: input.id ?? crypto.randomUUID(),
      userId: input.userId,
      provider: input.provider,
      accountId: input.accountId,
      accountName: input.accountName,
      avatarUrl: input.avatarUrl,
      authType: input.authType,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      status: input.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const data = JSON.stringify({
      accountId: connection.accountId,
      accountName: connection.accountName,
      avatarUrl: connection.avatarUrl,
      authType: connection.authType,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt,
      status: connection.status,
    });
    this.db
      .prepare(
        `INSERT INTO git_connections
          (id,userId,provider,data,accessToken,refreshToken,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
          provider=excluded.provider, data=excluded.data, accessToken=excluded.accessToken,
          refreshToken=excluded.refreshToken, updatedAt=excluded.updatedAt`,
      )
      .run(
        connection.id,
        connection.userId,
        connection.provider,
        data,
        this.cipher.encrypt(input.accessToken),
        input.refreshToken ? this.cipher.encrypt(input.refreshToken) : null,
        connection.createdAt,
        connection.updatedAt,
      );
    return connection;
  }

  async getSecrets(id: string): Promise<GitConnectionSecrets | undefined> {
    const row = this.db
      .prepare("SELECT accessToken, refreshToken FROM git_connections WHERE id = ?")
      .get(id) as Pick<ConnectionRow, "accessToken" | "refreshToken"> | undefined;
    if (!row) return undefined;
    return {
      accessToken: this.cipher.decrypt(row.accessToken),
      refreshToken: row.refreshToken ? this.cipher.decrypt(row.refreshToken) : undefined,
    };
  }

  async delete(id: string, userId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM git_repository_grants WHERE connectionId = ?").run(id);
      this.db.prepare("DELETE FROM git_connections WHERE id = ? AND userId = ?").run(id, userId);
    })();
  }

  async saveGrant(grant: GitRepositoryGrant): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO git_repository_grants
          (userId,agentId,repositoryId,repositoryFingerprint,connectionId,permission,grantedAt)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(userId,agentId,repositoryId) DO UPDATE SET
          repositoryFingerprint=excluded.repositoryFingerprint,
          connectionId=excluded.connectionId,
          permission=excluded.permission,
          grantedAt=excluded.grantedAt`,
      )
      .run(
        grant.userId,
        grant.agentId,
        grant.repositoryId,
        grant.repositoryFingerprint,
        grant.connectionId,
        grant.permission,
        grant.grantedAt,
      );
  }

  async getGrant(
    userId: string,
    agentId: string,
    repositoryId: string,
  ): Promise<GitRepositoryGrant | undefined> {
    return this.db
      .prepare(
        `SELECT userId,agentId,repositoryId,repositoryFingerprint,connectionId,permission,grantedAt
         FROM git_repository_grants WHERE userId = ? AND agentId = ? AND repositoryId = ?`,
      )
      .get(userId, agentId, repositoryId) as GitRepositoryGrant | undefined;
  }

  private toConnection(row: ConnectionRow): GitConnection {
    const data = JSON.parse(row.data) as Omit<
      GitConnection,
      "id" | "userId" | "provider" | "createdAt" | "updatedAt"
    >;
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      ...data,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
