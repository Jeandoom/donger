import type { Database } from "better-sqlite3";
import type {
  AgentShare,
  AgentShareGrant,
  AgentShareStore,
  ShareRef,
} from "../ports/agent-share-store.js";

export class SqliteAgentShareStore implements AgentShareStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
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

  async getShare(agentId: string): Promise<AgentShare | undefined> {
    const row = this.db.prepare("SELECT * FROM agent_shares WHERE agentId = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToShare(row) : undefined;
  }

  async enableShare(agentId: string): Promise<AgentShare> {
    const existing = await this.getShare(agentId);
    if (existing) {
      if (!existing.enabled) {
        this.db.prepare("UPDATE agent_shares SET enabled = 1 WHERE agentId = ?").run(agentId);
      }
      return { ...existing, enabled: true };
    }
    const share: AgentShare = {
      agentId,
      token: crypto.randomUUID(),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO agent_shares (agentId, token, enabled, createdAt) VALUES (?,?,1,?)")
      .run(share.agentId, share.token, share.createdAt);
    return share;
  }

  async disableShare(agentId: string): Promise<void> {
    this.db.prepare("UPDATE agent_shares SET enabled = 0 WHERE agentId = ?").run(agentId);
  }

  async listGrants(agentId: string): Promise<AgentShareGrant[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_share_grants WHERE agentId = ? ORDER BY grantedAt")
      .all(agentId) as Record<string, unknown>[];
    return rows.map((r) => ({
      agentId: r.agentId as string,
      userId: r.userId as string,
      grantedAt: r.grantedAt as string,
    }));
  }

  async addGrant(agentId: string, userId: string): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_share_grants (agentId, userId, grantedAt) VALUES (?,?,?)",
      )
      .run(agentId, userId, new Date().toISOString());
  }

  async removeGrant(agentId: string, userId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM agent_share_grants WHERE agentId = ? AND userId = ?")
      .run(agentId, userId);
    // 驱离语义（2026-09-24 审计）：被移除者曾持分享链接，不轮换 token 则可凭原链接
    // accept-share 自行重入名单。移除即换链：属主重新分发新链接，旧链接立即失效。
    this.db
      .prepare("UPDATE agent_shares SET token = ? WHERE agentId = ?")
      .run(crypto.randomUUID(), agentId);
  }

  async isGranted(agentId: string, userId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 FROM agent_share_grants g
         JOIN agent_shares s ON s.agentId = g.agentId
         WHERE g.agentId = ? AND g.userId = ? AND s.enabled = 1`,
      )
      .get(agentId, userId);
    return !!row;
  }

  async findByToken(token: string): Promise<ShareRef | undefined> {
    const row = this.db
      .prepare("SELECT agentId, enabled FROM agent_shares WHERE token = ?")
      .get(token) as { agentId: string; enabled: number } | undefined;
    return row ? { agentId: row.agentId, enabled: row.enabled === 1 } : undefined;
  }

  private rowToShare(row: Record<string, unknown>): AgentShare {
    return {
      agentId: row.agentId as string,
      token: row.token as string,
      enabled: row.enabled === 1,
      createdAt: row.createdAt as string,
    };
  }
}
