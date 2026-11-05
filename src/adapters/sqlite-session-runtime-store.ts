import type { Database } from "better-sqlite3";
import type {
  SessionRuntimeEntry,
  SessionRuntimeStore,
} from "../ports/session-runtime-store.js";

/** 会话 dev server 运行态持久化（spec 2026-11-04-webgame-dev-loop-design.md §3.3）。
 * PK=conversationId（一会话至多一行）；register 幂等——running 行原样返回。 */
export class SqliteSessionRuntimeStore implements SessionRuntimeStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_runtime (
        conversationId TEXT NOT NULL PRIMARY KEY,
        ownerId        TEXT NOT NULL,
        agentId        TEXT,
        port           INTEGER NOT NULL,
        cmd            TEXT NOT NULL,
        pid            INTEGER,
        status         TEXT NOT NULL DEFAULT 'running',
        startedAt      TEXT NOT NULL,
        lastAccessAt   TEXT NOT NULL
      )
    `);
  }

  async register(
    entry: Omit<SessionRuntimeEntry, "status" | "startedAt" | "lastAccessAt"> & {
      status?: SessionRuntimeEntry["status"];
      startedAt?: string;
      lastAccessAt?: string;
    },
  ): Promise<SessionRuntimeEntry> {
    const existing = await this.get(entry.conversationId);
    if (existing && existing.status === "running") return existing;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_runtime
           (conversationId, ownerId, agentId, port, cmd, pid, status, startedAt, lastAccessAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.conversationId,
        entry.ownerId,
        entry.agentId ?? null,
        entry.port,
        entry.cmd,
        entry.pid ?? null,
        "running",
        entry.startedAt ?? now,
        entry.lastAccessAt ?? now,
      );
    return (await this.get(entry.conversationId))!;
  }

  async get(conversationId: string): Promise<SessionRuntimeEntry | undefined> {
    const row = this.db
      .prepare("SELECT * FROM session_runtime WHERE conversationId = ?")
      .get(conversationId) as RuntimeRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  async markStopped(conversationId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "UPDATE session_runtime SET status = 'stopped', pid = NULL WHERE conversationId = ? AND status = 'running'",
      )
      .run(conversationId);
    return result.changes > 0;
  }

  async touch(conversationId: string, at?: string): Promise<void> {
    this.db
      .prepare("UPDATE session_runtime SET lastAccessAt = ? WHERE conversationId = ?")
      .run(at ?? new Date().toISOString(), conversationId);
  }

  async listRunning(): Promise<SessionRuntimeEntry[]> {
    const rows = this.db
      .prepare("SELECT * FROM session_runtime WHERE status = 'running' ORDER BY startedAt ASC")
      .all() as RuntimeRow[];
    return rows.map(rowToEntry);
  }

  async remove(conversationId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM session_runtime WHERE conversationId = ?")
      .run(conversationId);
    return result.changes > 0;
  }

  async markAllStopped(): Promise<number> {
    const result = this.db
      .prepare(
        "UPDATE session_runtime SET status = 'stopped', pid = NULL WHERE status = 'running'",
      )
      .run();
    return result.changes;
  }
}

interface RuntimeRow {
  conversationId: string;
  ownerId: string;
  agentId: string | null;
  port: number;
  cmd: string;
  pid: number | null;
  status: string;
  startedAt: string;
  lastAccessAt: string;
}

function rowToEntry(r: RuntimeRow): SessionRuntimeEntry {
  return {
    conversationId: r.conversationId,
    ownerId: r.ownerId,
    agentId: r.agentId,
    port: r.port,
    cmd: r.cmd,
    pid: r.pid,
    status: r.status === "running" ? "running" : "stopped",
    startedAt: r.startedAt,
    lastAccessAt: r.lastAccessAt,
  };
}
