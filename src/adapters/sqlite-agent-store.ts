import type { Database } from "better-sqlite3";
import type { Agent, AgentInput, McpServerConfig } from "../domain/agent.js";
import { parseAgent } from "../domain/agent.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { SecretCipher } from "../util/secret-cipher.js";

/** 持久化形态：env/headers 是加密后的字符串（而非 Record） */
type PersistedMcp = Omit<McpServerConfig, "env" | "headers"> & {
  env?: string;
  headers?: string;
};
type PersistedAgent = Omit<Agent, "mcpServers"> & { mcpServers: PersistedMcp[] };

export class SqliteAgentStore implements AgentStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, data TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(ownerId)");
    // 分享/授权表也在此创建（幂等），使 delete() 的级联清理在独立测试中安全；
    // SqliteAgentShareStore.migrate() 会幂等重建。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_shares (
        agentId TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_share_grants (
        agentId TEXT NOT NULL, userId TEXT NOT NULL,
        grantedAt TEXT NOT NULL, PRIMARY KEY (agentId, userId)
      )
    `);
  }

  async create(input: AgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const agent: Agent = {
      ...input,
      gitRepositories: input.gitRepositories ?? [],
      extensionDirectories: input.extensionDirectories ?? [],
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const data = this.marshal(agent);
    this.db
      .prepare("INSERT INTO agents (id, ownerId, data, createdAt, updatedAt) VALUES (?,?,?,?,?)")
      .run(agent.id, agent.ownerId, data, agent.createdAt, agent.updatedAt);
    return agent;
  }

  async get(id: string): Promise<Agent | undefined> {
    const row = this.db.prepare("SELECT data FROM agents WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? this.unmarshal(row.data) : undefined;
  }

  async listByOwner(ownerId: string): Promise<Agent[]> {
    const rows = this.db
      .prepare("SELECT data FROM agents WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as { data: string }[];
    return rows.map((r) => this.unmarshal(r.data));
  }

  async listSharedWith(userId: string): Promise<Agent[]> {
    const rows = this.db
      .prepare(
        `SELECT a.data AS data FROM agents a
         JOIN agent_share_grants g ON g.agentId = a.id
         JOIN agent_shares s ON s.agentId = a.id
         WHERE g.userId = ? AND s.enabled = 1
         ORDER BY a.updatedAt DESC`,
      )
      .all(userId) as { data: string }[];
    return rows.map((r) => this.unmarshal(r.data));
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`agent 不存在: ${id}`);
    const next: Agent = {
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE agents SET data = ?, updatedAt = ? WHERE id = ?")
      .run(this.marshal(next), next.updatedAt, id);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_share_grants WHERE agentId = ?").run(id);
      this.db.prepare("DELETE FROM agent_shares WHERE agentId = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    })();
  }

  /** 加密 mcpServers.env/headers 后序列化为持久化形态 */
  private marshal(a: Agent): string {
    const safe: PersistedAgent = {
      ...a,
      mcpServers: a.mcpServers.map(
        (s): PersistedMcp => ({
          ...s,
          env: s.env ? this.enc(s.env) : undefined,
          headers: s.headers ? this.enc(s.headers) : undefined,
        }),
      ),
    };
    return JSON.stringify(safe);
  }

  private unmarshal(data: string): Agent {
    const raw = JSON.parse(data) as PersistedAgent;
    const agent: Agent = {
      ...raw,
      mcpServers: raw.mcpServers.map(
        (s): McpServerConfig => ({
          ...s,
          env: s.env ? this.dec(s.env) : undefined,
          headers: s.headers ? this.dec(s.headers) : undefined,
        }),
      ),
    };
    return parseAgent(agent);
  }

  private enc(obj: Record<string, string>): string {
    return this.cipher.encrypt(JSON.stringify(obj));
  }
  private dec(blob: string): Record<string, string> {
    return JSON.parse(this.cipher.decrypt(blob)) as Record<string, string>;
  }
}
