import type { Database } from "better-sqlite3";
import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptSessionSummary,
  TranscriptStore,
} from "../ports/transcript-store.js";

interface SubkeyRow {
  subkey: string;
}

/**
 * TranscriptStore 的 SQLite 实现。
 * - transcript_entries：每条一个 JSONL 行（payload 透传，uuid 幂等）
 * - transcript_subkeys：登记子 agent subpath，供 listSubkeys
 */
export class SqliteTranscriptStore implements TranscriptStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_entries (
        uuid        TEXT,
        project_key TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        subpath     TEXT NOT NULL DEFAULT '',
        conv_id     TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(project_key, session_id, subpath, uuid)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_te_session ON transcript_entries(project_key, session_id, subpath, seq)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_te_conv ON transcript_entries(conv_id, seq)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_subkeys (
        project_key TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        subkey      TEXT NOT NULL,
        PRIMARY KEY(project_key, session_id, subkey)
      )
    `);
  }

  async append(
    key: TranscriptKey,
    conversationId: string,
    entries: TranscriptEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? "";
    const insertEntry = this.db.prepare(
      `INSERT OR IGNORE INTO transcript_entries
       (uuid, project_key, session_id, subpath, conv_id, seq, payload, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const nextSeqStmt = this.db.prepare(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM transcript_entries
       WHERE project_key = ? AND session_id = ? AND subpath = ?`,
    );
    const upsertSubkey = this.db.prepare(
      `INSERT OR IGNORE INTO transcript_subkeys (project_key, session_id, subkey) VALUES (?,?,?)`,
    );
    const tx = this.db.transaction((rows: TranscriptEntry[]) => {
      for (const e of rows) {
        const { next } = nextSeqStmt.get(key.projectKey, key.sessionId, subpath) as {
          next: number;
        };
        insertEntry.run(
          e.uuid ?? null,
          key.projectKey,
          key.sessionId,
          subpath,
          conversationId,
          next,
          JSON.stringify(e),
          e.timestamp ?? new Date().toISOString(),
        );
      }
      if (subpath) upsertSubkey.run(key.projectKey, key.sessionId, subpath);
    });
    tx(entries);
  }

  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const subpath = key.subpath ?? "";
    const rows = this.db
      .prepare(
        `SELECT payload FROM transcript_entries
         WHERE project_key = ? AND session_id = ? AND subpath = ?
         ORDER BY seq ASC`,
      )
      .all(key.projectKey, key.sessionId, subpath) as { payload: string }[];
    if (rows.length === 0) return null;
    return rows.map((r) => JSON.parse(r.payload) as TranscriptEntry);
  }

  async listSessions(projectKey: string): Promise<TranscriptSessionSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT session_id, MAX(created_at) AS mtime_iso
         FROM transcript_entries
         WHERE project_key = ? AND subpath = ''
         GROUP BY session_id`,
      )
      .all(projectKey) as { session_id: string; mtime_iso: string }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      mtime: Date.parse(r.mtime_iso),
    }));
  }

  async listSubkeys(key: TranscriptKey): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT subkey FROM transcript_subkeys WHERE project_key = ? AND session_id = ?")
      .all(key.projectKey, key.sessionId) as SubkeyRow[];
    return rows.map((r) => r.subkey);
  }

  async delete(key: TranscriptKey): Promise<void> {
    this.db
      .prepare("DELETE FROM transcript_entries WHERE project_key = ? AND session_id = ?")
      .run(key.projectKey, key.sessionId);
    this.db
      .prepare("DELETE FROM transcript_subkeys WHERE project_key = ? AND session_id = ?")
      .run(key.projectKey, key.sessionId);
  }
}
