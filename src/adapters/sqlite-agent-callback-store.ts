import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { AgentCallback, AgentCallbackStore } from "../ports/agent-callback-store.js";

/** 生成 32 字符高熵随机 token（24 字节 → base64url，无填充） */
export function generateCallbackToken(): string {
  return randomBytes(24).toString("base64url");
}

export class SqliteAgentCallbackStore implements AgentCallbackStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_callbacks (
        token TEXT PRIMARY KEY,
        agentId TEXT NOT NULL UNIQUE,
        ownerId TEXT NOT NULL,
        expiresAt TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    // token↔会话绑定（规格 M4）：结果查询只放行该 token 发起的会话；NULL=升级前的旧行（宽松）
    const cols = (
      this.db.prepare("PRAGMA table_info(agent_callbacks)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!cols.includes("lastConversationId")) {
      this.db.exec("ALTER TABLE agent_callbacks ADD COLUMN lastConversationId TEXT");
    }
  }

  async get(agentId: string): Promise<AgentCallback | undefined> {
    const row = this.db.prepare("SELECT * FROM agent_callbacks WHERE agentId = ?").get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToCallback(row) : undefined;
  }

  async findByToken(token: string): Promise<AgentCallback | undefined> {
    const row = this.db.prepare("SELECT * FROM agent_callbacks WHERE token = ?").get(token) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToCallback(row) : undefined;
  }

  async getLastConversationId(token: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT lastConversationId FROM agent_callbacks WHERE token = ?")
      .get(token) as { lastConversationId: string | null } | undefined;
    return row?.lastConversationId ?? undefined;
  }

  async upsert(agentId: string, ownerId: string, validityDays?: number): Promise<AgentCallback> {
    const now = new Date();
    const callback: AgentCallback = {
      token: generateCallbackToken(),
      agentId,
      ownerId,
      expiresAt: validityDays
        ? new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString()
        : null,
      createdAt: now.toISOString(),
    };
    // agentId UNIQUE + INSERT OR REPLACE：覆盖旧行，旧 token 随之失效（即吊销）
    this.db
      .prepare(
        "INSERT OR REPLACE INTO agent_callbacks (token, agentId, ownerId, expiresAt, createdAt) VALUES (?,?,?,?,?)",
      )
      .run(callback.token, agentId, ownerId, callback.expiresAt, callback.createdAt);
    return callback;
  }

  async recordConversation(token: string, conversationId: string): Promise<void> {
    this.db
      .prepare("UPDATE agent_callbacks SET lastConversationId = ? WHERE token = ?")
      .run(conversationId, token);
  }

  async revoke(agentId: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_callbacks WHERE agentId = ?").run(agentId);
  }

  private rowToCallback(row: Record<string, unknown>): AgentCallback {
    return {
      token: row.token as string,
      agentId: row.agentId as string,
      ownerId: row.ownerId as string,
      expiresAt: (row.expiresAt as string | null) ?? null,
      createdAt: row.createdAt as string,
    };
  }
}
