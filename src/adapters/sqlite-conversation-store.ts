import type { Database } from "better-sqlite3";
import type { Conversation } from "../domain/conversation.js";
import { AgentPermissionModeSchema } from "../domain/permission-mode.js";
import type { ConversationStore } from "../ports/conversation-store.js";

export class SqliteConversationStore implements ConversationStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        sdkSessionId TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        channelId TEXT NOT NULL,
        agentId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ensureAgentIdColumn();
    this.ensurePermissionModeColumn();
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(userId, archived, updatedAt DESC)",
    );
  }

  /** 旧库无 agentId 列则幂等补列（仿 upgradeUsersSchema） */
  private ensureAgentIdColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "agentId")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN agentId TEXT NOT NULL DEFAULT ''");
    }
  }

  /** 会话权限模式覆盖列；NULL = 跟随智能体默认 */
  private ensurePermissionModeColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "permissionMode")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN permissionMode TEXT");
    }
  }

  async create(userId: string, channelId: string, title: string): Promise<Conversation> {
    return this.createWithAgent(userId, channelId, title, "");
  }

  async createWithAgent(
    userId: string,
    channelId: string,
    title: string,
    agentId: string,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: crypto.randomUUID(),
      userId,
      sdkSessionId: "",
      title,
      channelId,
      agentId,
      permissionMode: undefined,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    this.db
      .prepare(
        "INSERT INTO conversations (id, userId, sdkSessionId, title, channelId, agentId, permissionMode, createdAt, updatedAt, archived) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        conv.id,
        conv.userId,
        conv.sdkSessionId,
        conv.title,
        conv.channelId,
        conv.agentId,
        null,
        conv.createdAt,
        conv.updatedAt,
        0,
      );
    return conv;
  }

  async get(id: string): Promise<Conversation | undefined> {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToConv(row) : undefined;
  }

  async listByUser(userId: string): Promise<Conversation[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM conversations WHERE userId = ? AND archived = 0 ORDER BY updatedAt DESC",
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToConv(r));
  }

  async getLatest(userId: string, channelId: string): Promise<Conversation | undefined> {
    const row = this.db
      .prepare(
        "SELECT * FROM conversations WHERE userId = ? AND channelId = ? AND archived = 0 ORDER BY updatedAt DESC LIMIT 1",
      )
      .get(userId, channelId) as Record<string, unknown> | undefined;
    return row ? this.rowToConv(row) : undefined;
  }

  async update(id: string, patch: Partial<Conversation>): Promise<void> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`conversation 不存在: ${id}`);
    const updated = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        "UPDATE conversations SET sdkSessionId = ?, title = ?, agentId = ?, permissionMode = ?, archived = ?, updatedAt = ? WHERE id = ?",
      )
      .run(
        updated.sdkSessionId,
        updated.title,
        updated.agentId,
        updated.permissionMode ?? null,
        updated.archived ? 1 : 0,
        updated.updatedAt,
        id,
      );
  }

  private rowToConv(row: Record<string, unknown>): Conversation {
    const permissionMode =
      typeof row.permissionMode === "string" && row.permissionMode !== ""
        ? AgentPermissionModeSchema.parse(row.permissionMode)
        : undefined;
    return {
      id: row.id as string,
      userId: row.userId as string,
      sdkSessionId: row.sdkSessionId as string,
      title: row.title as string,
      channelId: row.channelId as string,
      agentId: (row.agentId as string) ?? "",
      permissionMode,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      archived: row.archived === 1,
    };
  }
}
