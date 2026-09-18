import type { Database } from "better-sqlite3";
import type { Comment } from "../domain/comment.js";
import type { CommentStore } from "../ports/comment-store.js";

export class SqliteCommentStore implements CommentStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        userId TEXT NOT NULL,
        text TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(taskId, createdAt)",
    );
  }

  async add(taskId: string, userId: string, text: string): Promise<Comment> {
    const comment: Comment = {
      id: crypto.randomUUID(),
      taskId,
      userId,
      text,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO task_comments (id, taskId, userId, text, createdAt) VALUES (?,?,?,?,?)")
      .run(comment.id, comment.taskId, comment.userId, comment.text, comment.createdAt);
    return comment;
  }

  async listByTask(taskId: string): Promise<Comment[]> {
    const rows = this.db
      .prepare("SELECT * FROM task_comments WHERE taskId = ? ORDER BY createdAt ASC")
      .all(taskId) as Array<{
      id: string;
      taskId: string;
      userId: string;
      text: string;
      createdAt: string;
    }>;
    return rows;
  }
}
