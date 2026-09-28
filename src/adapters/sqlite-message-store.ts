import type { Database } from "better-sqlite3";
import type { StoredMessage } from "../domain/types.js";
import type { MessageStore } from "../ports/message-store.js";

export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL
      )
    `);
    // 回合归属（2026-09-14 turn UI）：旧库补列，可空零回填
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "taskId")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN taskId TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId, createdAt ASC)",
    );
  }

  async add(
    conversationId: string,
    role: "user" | "bot",
    text: string,
    files: string = "[]",
    taskId?: string,
    opts?: { createdAt?: string },
  ): Promise<StoredMessage> {
    const now = new Date().toISOString();
    const msg: StoredMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role,
      text,
      files,
      ...(taskId ? { taskId } : {}),
      // createdAt 可回填历史时间戳（zcode 轮末对账，specs/2026-09-29-zcode-record-fidelity-design.md
      // M2）：消息序按回填值；会话活跃度按墙钟 now——用回填旧时间刷 updatedAt 会把活跃会话沉底
      createdAt: opts?.createdAt ?? now,
    };
    this.db
      .prepare(
        "INSERT INTO messages (id, conversationId, role, text, files, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        msg.id,
        msg.conversationId,
        msg.role,
        msg.text,
        msg.files,
        msg.taskId ?? null,
        msg.createdAt,
      );
    // 会话活跃度 = 最后一条消息：列表排序与 getLatest 都按 updatedAt DESC，
    // 不随消息刷新会让活跃会话沉底、取「最近会话」取错（conversationStore.update 只在
    // sdkSessionId/title/agentId 变化时被调用）。此处统一兜底刷新；
    // conversations 表由 conversation store 负责建，缺表（极端迁移顺序）时跳过。
    const hasConversations = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get();
    if (hasConversations) {
      this.db
        .prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?")
        .run(now, conversationId);
    }
    return msg;
  }

  async listByConversation(conversationId: string): Promise<StoredMessage[]> {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt ASC")
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      conversationId: r.conversationId as string,
      role: r.role as "user" | "bot",
      text: r.text as string,
      files: r.files as string,
      ...(typeof r.taskId === "string" && r.taskId ? { taskId: r.taskId } : {}),
      createdAt: r.createdAt as string,
    }));
  }
}
