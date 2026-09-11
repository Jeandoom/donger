import type { Database } from "better-sqlite3";
import type { Agent, AgentInput, AgentVersionSummary, McpServerConfig } from "../domain/agent.js";
import { normalizeAgentCredentialRefs, parseAgent } from "../domain/agent.js";
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
    this.migrateVersions();
  }

  /** 版本表 + 存量回填（无版本记录的 agent 建立基线 v1，幂等） */
  private migrateVersions(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_versions (
        agentId TEXT NOT NULL, version INTEGER NOT NULL,
        data TEXT NOT NULL, createdAt TEXT NOT NULL,
        PRIMARY KEY (agentId, version)
      )
    `);
    const rows = this.db
      .prepare(
        `SELECT a.id, a.data, a.createdAt FROM agents a
         LEFT JOIN agent_versions v ON v.agentId = a.id AND v.version = 1
         WHERE v.agentId IS NULL`,
      )
      .all() as Array<{ id: string; data: string; createdAt: string }>;
    const insert = this.db.prepare(
      "INSERT INTO agent_versions (agentId, version, data, createdAt) VALUES (?, 1, ?, ?)",
    );
    for (const r of rows) insert.run(r.id, r.data, r.createdAt);
  }

  async create(input: AgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    // credentialCode 归一化并入 credentials（store 层收口，REST/builder/rollback 各入口共用）；
    // parseAgent 在落库前兜底校验——非法数据一旦写入，读路径 unmarshal 会让整个列表 500
    const agent: Agent = parseAgent(
      normalizeAgentCredentialRefs({
        ...input,
        gitRepositories: input.gitRepositories ?? [],
        extensionDirectories: input.extensionDirectories ?? [],
        credentials: input.credentials ?? [],
        connectorIds: input.connectorIds ?? [],
        id: crypto.randomUUID(),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const data = this.marshal(agent);
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO agents (id, ownerId, data, createdAt, updatedAt) VALUES (?,?,?,?,?)")
        .run(agent.id, agent.ownerId, data, agent.createdAt, agent.updatedAt);
      this.db
        .prepare(
          "INSERT INTO agent_versions (agentId, version, data, createdAt) VALUES (?, 1, ?, ?)",
        )
        .run(agent.id, data, agent.createdAt);
    })();
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

  async listAll(): Promise<Agent[]> {
    const rows = this.db.prepare("SELECT data FROM agents ORDER BY updatedAt DESC").all() as {
      data: string;
    }[];
    return rows.map((r) => this.unmarshal(r.data));
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`agent 不存在: ${id}`);
    // parseAgent 在落库前兜底校验（web PATCH 等调用方的 patch 可能未经 schema 校验）
    const next: Agent = parseAgent(
      normalizeAgentCredentialRefs({
        ...cur,
        ...patch,
        id: cur.id,
        ownerId: cur.ownerId,
        createdAt: cur.createdAt,
        // version 由 store 独占管理：每次 update 自增（patch 无法注入），rollback 亦计入
        version: cur.version + 1,
        updatedAt: new Date().toISOString(),
      }),
    );
    const data = this.marshal(next);
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE agents SET data = ?, updatedAt = ? WHERE id = ?")
        .run(data, next.updatedAt, id);
      this.db
        .prepare(
          "INSERT INTO agent_versions (agentId, version, data, createdAt) VALUES (?, ?, ?, ?)",
        )
        .run(id, next.version, data, next.updatedAt);
    })();
    return next;
  }

  async listVersions(agentId: string): Promise<AgentVersionSummary[]> {
    const rows = this.db
      .prepare(
        "SELECT version, data, createdAt FROM agent_versions WHERE agentId = ? ORDER BY version DESC",
      )
      .all(agentId) as Array<{ version: number; data: string; createdAt: string }>;
    return rows.map((r) => {
      // data 为持久化形态（mcpServers env/headers 是密文），摘要只取明文字段，不解密不外泄
      const raw = JSON.parse(r.data) as {
        name?: string;
        description?: string;
        skills?: string[];
      };
      return {
        agentId,
        version: r.version,
        name: raw.name ?? "",
        description: raw.description,
        skills: raw.skills ?? [],
        createdAt: r.createdAt,
      };
    });
  }

  async rollback(id: string, version: number): Promise<Agent> {
    const row = this.db
      .prepare("SELECT data FROM agent_versions WHERE agentId = ? AND version = ?")
      .get(id, version) as { data: string } | undefined;
    if (!row) throw new Error(`版本不存在: agent ${id} v${version}`);
    const snap = this.unmarshal(row.data);
    // 以快照内容做一次普通 update：生成新版本，历史链不被改写
    return this.update(id, {
      name: snap.name,
      description: snap.description,
      systemPrompt: snap.systemPrompt,
      skills: snap.skills,
      defaultSkill: snap.defaultSkill,
      tools: snap.tools,
      mcpServers: snap.mcpServers,
      connectorIds: snap.connectorIds,
      gitRepositories: snap.gitRepositories,
      extensionDirectories: snap.extensionDirectories,
      llm: snap.llm,
    });
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
