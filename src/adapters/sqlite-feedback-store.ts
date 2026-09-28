import type { Database } from "better-sqlite3";
import type { Feedback, FeedbackReply, FeedbackStatus } from "../domain/feedback.js";
import type { FeedbackStore } from "../ports/feedback-store.js";

interface FeedbackRow {
  id: string;
  userId: string;
  category: string;
  content: string;
  images: string;
  conversationIds: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ReplyRow {
  id: string;
  feedbackId: string;
  userId: string;
  authorRole: string;
  content: string;
  createdAt: string;
}

function rowToFeedback(r: FeedbackRow): Feedback {
  let images: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.images);
    if (Array.isArray(parsed)) images = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // 毒数据兜底：坏 JSON 视为无图
  }
  let conversationIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.conversationIds ?? "[]");
    if (Array.isArray(parsed)) {
      conversationIds = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // 毒数据兜底：坏 JSON 视为无关联会话
  }
  return {
    id: r.id,
    userId: r.userId,
    category: r.category as Feedback["category"],
    content: r.content,
    images,
    conversationIds,
    status: r.status as Feedback["status"],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToReply(r: ReplyRow): FeedbackReply {
  return {
    id: r.id,
    feedbackId: r.feedbackId,
    userId: r.userId,
    authorRole: r.authorRole as FeedbackReply["authorRole"],
    content: r.content,
    createdAt: r.createdAt,
  };
}

export class SqliteFeedbackStore implements FeedbackStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_items (
        id        TEXT PRIMARY KEY,
        userId    TEXT NOT NULL,
        category  TEXT NOT NULL,
        content   TEXT NOT NULL,
        images    TEXT NOT NULL DEFAULT '[]',
        status    TEXT NOT NULL DEFAULT 'open',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_items_userId ON feedback_items(userId)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_feedback_items_createdAt ON feedback_items(createdAt)",
    );
    // 关联对话记录列（spec 2026-09-28-feedback-conversation-attachment-design）；存量表守卫加列
    const cols = this.db.prepare("PRAGMA table_info(feedback_items)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "conversationIds")) {
      this.db.exec(
        "ALTER TABLE feedback_items ADD COLUMN conversationIds TEXT NOT NULL DEFAULT '[]'",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_replies (
        id         TEXT PRIMARY KEY,
        feedbackId TEXT NOT NULL,
        userId     TEXT NOT NULL,
        authorRole TEXT NOT NULL,
        content    TEXT NOT NULL,
        createdAt  TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_feedback_replies_feedbackId ON feedback_replies(feedbackId)",
    );
  }

  async create(feedback: Feedback): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO feedback_items (id, userId, category, content, images, conversationIds, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id,
        feedback.userId,
        feedback.category,
        feedback.content,
        JSON.stringify(feedback.images),
        JSON.stringify(feedback.conversationIds ?? []),
        feedback.status,
        feedback.createdAt,
        feedback.updatedAt,
      );
  }

  async get(id: string): Promise<Feedback | undefined> {
    const row = this.db.prepare("SELECT * FROM feedback_items WHERE id = ?").get(id) as
      | FeedbackRow
      | undefined;
    return row ? rowToFeedback(row) : undefined;
  }

  async listByUser(userId: string): Promise<Feedback[]> {
    const rows = this.db
      .prepare("SELECT * FROM feedback_items WHERE userId = ? ORDER BY createdAt DESC")
      .all(userId) as FeedbackRow[];
    return rows.map(rowToFeedback);
  }

  async listAll(): Promise<Feedback[]> {
    const rows = this.db
      .prepare("SELECT * FROM feedback_items ORDER BY createdAt DESC")
      .all() as FeedbackRow[];
    return rows.map(rowToFeedback);
  }

  async updateStatus(id: string, status: FeedbackStatus): Promise<void> {
    this.db
      .prepare("UPDATE feedback_items SET status = ?, updatedAt = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  async addReply(reply: FeedbackReply): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO feedback_replies (id, feedbackId, userId, authorRole, content, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reply.id,
        reply.feedbackId,
        reply.userId,
        reply.authorRole,
        reply.content,
        reply.createdAt,
      );
    // 回复同时 bump 主项 updatedAt；MAX 防乱序插入把时间回退
    this.db
      .prepare("UPDATE feedback_items SET updatedAt = MAX(updatedAt, ?) WHERE id = ?")
      .run(reply.createdAt, reply.feedbackId);
  }

  async listReplies(feedbackId: string): Promise<FeedbackReply[]> {
    const rows = this.db
      .prepare("SELECT * FROM feedback_replies WHERE feedbackId = ? ORDER BY createdAt ASC, id ASC")
      .all(feedbackId) as ReplyRow[];
    return rows.map(rowToReply);
  }
}
