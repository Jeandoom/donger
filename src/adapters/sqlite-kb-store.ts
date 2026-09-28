import type { Database } from "better-sqlite3";
import type { KbLibrary, KbLibraryInput, KbRevision, KbRevisionInput } from "../domain/kb.js";
import { parseKbLibrary } from "../domain/kb.js";
import type {
  KbLibraryStore,
  KbRevisionListQuery,
  KbRevisionStore,
  KbShare,
  KbShareGrant,
  KbShareStore,
} from "../ports/kb-store.js";

const REVISION_DIFF_KEEP = 50;

/**
 * 知识库三表 store（spec 2026-09-22-knowledge-base-design §6）：
 * kb_libraries（元数据，平铺列）/ kb_shares+kb_share_grants（同构 agent 分享）/ kb_revisions（账本）。
 * 全部 migrate 幂等；删库时账本保留（handler 只调 libraryStore.delete + 自行补 library-deleted 尾条）。
 */
export class SqliteKbLibraryStore implements KbLibraryStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_libraries (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        systemPrompt TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0,
        personal INTEGER NOT NULL DEFAULT 0,
        sourceAgentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(ownerId, name)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kb_lib_owner ON kb_libraries(ownerId)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_kb_lib_personal ON kb_libraries(ownerId, personal)",
    );
    // 分享/授权表在此幂等同建（delete 级联清理在独立测试中安全；SqliteKbShareStore.migrate 会重建）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_shares (
        kbId TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_share_grants (
        kbId TEXT NOT NULL, userId TEXT NOT NULL,
        grantedAt TEXT NOT NULL, PRIMARY KEY (kbId, userId)
      )
    `);
  }

  async create(input: KbLibraryInput): Promise<KbLibrary> {
    const now = new Date().toISOString();
    const lib = parseKbLibrary({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO kb_libraries
         (id, ownerId, name, description, systemPrompt, builtin, personal, sourceAgentId, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        lib.id,
        lib.ownerId,
        lib.name,
        lib.description,
        lib.systemPrompt,
        lib.builtin ? 1 : 0,
        lib.personal ? 1 : 0,
        lib.sourceAgentId ?? null,
        lib.createdAt,
        lib.updatedAt,
      );
    return lib;
  }

  async get(id: string): Promise<KbLibrary | undefined> {
    const row = this.db.prepare("SELECT * FROM kb_libraries WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToLibrary(row) : undefined;
  }

  async listByOwner(ownerId: string): Promise<KbLibrary[]> {
    const rows = this.db
      .prepare("SELECT * FROM kb_libraries WHERE ownerId = ? ORDER BY updatedAt DESC")
      .all(ownerId) as Record<string, unknown>[];
    return rows.map(rowToLibrary);
  }

  async listSharedWith(userId: string): Promise<KbLibrary[]> {
    const rows = this.db
      .prepare(
        `SELECT l.* FROM kb_libraries l
         JOIN kb_share_grants g ON g.kbId = l.id
         JOIN kb_shares s ON s.kbId = l.id
         WHERE g.userId = ? AND s.enabled = 1
         ORDER BY l.updatedAt DESC`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map(rowToLibrary);
  }

  async listAll(): Promise<KbLibrary[]> {
    const rows = this.db
      .prepare("SELECT * FROM kb_libraries ORDER BY updatedAt DESC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToLibrary);
  }

  async findPersonalByOwner(ownerId: string): Promise<KbLibrary | undefined> {
    const row = this.db
      .prepare("SELECT * FROM kb_libraries WHERE ownerId = ? AND personal = 1")
      .get(ownerId) as Record<string, unknown> | undefined;
    return row ? rowToLibrary(row) : undefined;
  }

  async findBySourceAgent(sourceAgentId: string): Promise<KbLibrary | undefined> {
    const row = this.db
      .prepare("SELECT * FROM kb_libraries WHERE sourceAgentId = ?")
      .get(sourceAgentId) as Record<string, unknown> | undefined;
    return row ? rowToLibrary(row) : undefined;
  }

  async update(id: string, patch: Partial<KbLibrary>): Promise<KbLibrary> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`知识库不存在: ${id}`);
    const next = parseKbLibrary({
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE kb_libraries SET name = ?, description = ?, systemPrompt = ?, sourceAgentId = ?, updatedAt = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.systemPrompt,
        next.sourceAgentId ?? null,
        next.updatedAt,
        id,
      );
    return next;
  }

  /** 仅删库记录；调用方负责文件目录清理与账本 library-deleted 尾条（账本保留） */
  async delete(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM kb_share_grants WHERE kbId = ?").run(id);
      this.db.prepare("DELETE FROM kb_shares WHERE kbId = ?").run(id);
      this.db.prepare("DELETE FROM kb_libraries WHERE id = ?").run(id);
    })();
  }

  async ensurePersonalLibrary(userId: string): Promise<KbLibrary> {
    const existing = await this.findPersonalByOwner(userId);
    if (existing) return existing;
    try {
      return await this.create({
        ownerId: userId,
        name: "个人知识库",
        description: "个人空间：经验记忆与个人笔记（系统自动创建）",
        systemPrompt: "",
        personal: true,
        builtin: false,
      });
    } catch {
      // UNIQUE(ownerId,name) 并发双跑：另一请求已建，回读
      const lib = await this.findPersonalByOwner(userId);
      if (!lib) throw new Error(`个人知识库创建失败: ${userId}`);
      return lib;
    }
  }
}

export class SqliteKbShareStore implements KbShareStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_shares (
        kbId TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_share_grants (
        kbId TEXT NOT NULL, userId TEXT NOT NULL,
        grantedAt TEXT NOT NULL, PRIMARY KEY (kbId, userId)
      )
    `);
  }

  async getShare(kbId: string): Promise<KbShare | undefined> {
    const row = this.db.prepare("SELECT * FROM kb_shares WHERE kbId = ?").get(kbId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToShare(row) : undefined;
  }

  async enableShare(kbId: string): Promise<KbShare> {
    const existing = await this.getShare(kbId);
    if (existing) {
      if (!existing.enabled) {
        this.db.prepare("UPDATE kb_shares SET enabled = 1 WHERE kbId = ?").run(kbId);
      }
      return { ...existing, enabled: true };
    }
    const share: KbShare = {
      kbId,
      token: crypto.randomUUID(),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO kb_shares (kbId, token, enabled, createdAt) VALUES (?,?,1,?)")
      .run(share.kbId, share.token, share.createdAt);
    return share;
  }

  async disableShare(kbId: string): Promise<void> {
    this.db.prepare("UPDATE kb_shares SET enabled = 0 WHERE kbId = ?").run(kbId);
  }

  async listGrants(kbId: string): Promise<KbShareGrant[]> {
    const rows = this.db
      .prepare("SELECT * FROM kb_share_grants WHERE kbId = ? ORDER BY grantedAt")
      .all(kbId) as Record<string, unknown>[];
    return rows.map((r) => ({
      kbId: r.kbId as string,
      userId: r.userId as string,
      grantedAt: r.grantedAt as string,
    }));
  }

  async addGrant(kbId: string, userId: string): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO kb_share_grants (kbId, userId, grantedAt) VALUES (?,?,?)")
      .run(kbId, userId, new Date().toISOString());
  }

  async removeGrant(kbId: string, userId: string): Promise<void> {
    this.db.prepare("DELETE FROM kb_share_grants WHERE kbId = ? AND userId = ?").run(kbId, userId);
    // 驱离语义（同 agent 分享，2026-09-24 审计）：被移除者凭旧链接 accept-share 重入的
    // 路径随旧 token 失效；属主重新分发新链接。
    this.db.prepare("UPDATE kb_shares SET token = ? WHERE kbId = ?").run(crypto.randomUUID(), kbId);
  }

  async isGranted(kbId: string, userId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 FROM kb_share_grants g
         JOIN kb_shares s ON s.kbId = g.kbId
         WHERE g.kbId = ? AND g.userId = ? AND s.enabled = 1`,
      )
      .get(kbId, userId);
    return !!row;
  }

  async findByToken(token: string): Promise<{ kbId: string; enabled: boolean } | undefined> {
    const row = this.db.prepare("SELECT kbId, enabled FROM kb_shares WHERE token = ?").get(token) as
      | { kbId: string; enabled: number }
      | undefined;
    return row ? { kbId: row.kbId, enabled: row.enabled === 1 } : undefined;
  }

  private rowToShare(row: Record<string, unknown>): KbShare {
    return {
      kbId: row.kbId as string,
      token: row.token as string,
      enabled: row.enabled === 1,
      createdAt: row.createdAt as string,
    };
  }
}

export class SqliteKbRevisionStore implements KbRevisionStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_revisions (
        id TEXT PRIMARY KEY,
        kbId TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        actorUserId TEXT NOT NULL,
        actorKind TEXT NOT NULL,
        conversationId TEXT,
        taskId TEXT,
        summary TEXT NOT NULL DEFAULT '',
        beforeHash TEXT,
        afterHash TEXT,
        diffText TEXT,
        createdAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kb_rev_kb ON kb_revisions(kbId, createdAt DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kb_rev_time ON kb_revisions(createdAt DESC)");
  }

  async record(input: KbRevisionInput): Promise<KbRevision> {
    const rev: KbRevision = {
      id: crypto.randomUUID(),
      kbId: input.kbId,
      path: input.path,
      action: input.action,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      summary: input.summary ?? "",
      ...(input.beforeHash ? { beforeHash: input.beforeHash } : {}),
      ...(input.afterHash ? { afterHash: input.afterHash } : {}),
      ...(input.diffText ? { diffText: input.diffText } : {}),
      createdAt: new Date().toISOString(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kb_revisions
           (id, kbId, path, action, actorUserId, actorKind, conversationId, taskId, summary, beforeHash, afterHash, diffText, createdAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          rev.id,
          rev.kbId,
          rev.path,
          rev.action,
          rev.actorUserId,
          rev.actorKind,
          rev.conversationId ?? null,
          rev.taskId ?? null,
          rev.summary,
          rev.beforeHash ?? null,
          rev.afterHash ?? null,
          rev.diffText ?? null,
          rev.createdAt,
        );
      // 保留策略（spec §6.1）：同 kbId+path 仅最近 N 条留 diff/summary，更早的置空（行与时间线保留）
      this.db
        .prepare(
          `UPDATE kb_revisions SET diffText = NULL, summary = ''
           WHERE kbId = ? AND path = ? AND id NOT IN (
             SELECT id FROM kb_revisions WHERE kbId = ? AND path = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(rev.kbId, rev.path, rev.kbId, rev.path, REVISION_DIFF_KEEP);
    })();
    return rev;
  }

  async listByKb(
    kbId: string,
    opts?: { path?: string; limit?: number; offset?: number },
  ): Promise<KbRevision[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.offset ?? 0;
    if (opts?.path !== undefined) {
      const rows = this.db
        .prepare(
          "SELECT * FROM kb_revisions WHERE kbId = ? AND path = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?",
        )
        .all(kbId, opts.path, limit, offset) as Record<string, unknown>[];
      return rows.map(rowToRevision);
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM kb_revisions WHERE kbId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?",
      )
      .all(kbId, limit, offset) as Record<string, unknown>[];
    return rows.map(rowToRevision);
  }

  async listByKbIds(
    kbIds: readonly string[],
    limit: number,
    offset: number,
  ): Promise<KbRevision[]> {
    if (kbIds.length === 0) return [];
    const capped = Math.min(limit, 500);
    // 库数量小（个人 1 + 自建 + 被授予），逐库取后内存归一排序（SQLite 变参 IN 的 bind 复杂度不值当）
    const all: KbRevision[] = [];
    for (const kbId of kbIds) {
      all.push(...(await this.listByKb(kbId, { limit: capped + offset })));
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all.slice(offset, offset + capped);
  }

  async listAll(query: KbRevisionListQuery): Promise<KbRevision[]> {
    const limit = Math.min(query.limit, 500);
    const offset = query.offset;
    if (query.kbId !== undefined) return this.listByKb(query.kbId, { limit, offset });
    const rows = this.db
      .prepare("SELECT * FROM kb_revisions ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
    return rows.map(rowToRevision);
  }

  async countByKb(kbId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM kb_revisions WHERE kbId = ?")
      .get(kbId) as { n: number };
    return row.n;
  }
}

function rowToLibrary(row: Record<string, unknown>): KbLibrary {
  return parseKbLibrary({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description ?? "",
    systemPrompt: row.systemPrompt ?? "",
    builtin: row.builtin === 1,
    personal: row.personal === 1,
    ...(typeof row.sourceAgentId === "string" && row.sourceAgentId !== ""
      ? { sourceAgentId: row.sourceAgentId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function rowToRevision(row: Record<string, unknown>): KbRevision {
  return {
    id: row.id as string,
    kbId: row.kbId as string,
    path: (row.path as string) ?? "",
    action: row.action as KbRevision["action"],
    actorUserId: row.actorUserId as string,
    actorKind: row.actorKind as KbRevision["actorKind"],
    ...(typeof row.conversationId === "string" && row.conversationId !== ""
      ? { conversationId: row.conversationId }
      : {}),
    ...(typeof row.taskId === "string" && row.taskId !== "" ? { taskId: row.taskId } : {}),
    summary: (row.summary as string) ?? "",
    ...(typeof row.beforeHash === "string" && row.beforeHash !== ""
      ? { beforeHash: row.beforeHash }
      : {}),
    ...(typeof row.afterHash === "string" && row.afterHash !== ""
      ? { afterHash: row.afterHash }
      : {}),
    ...(typeof row.diffText === "string" && row.diffText !== "" ? { diffText: row.diffText } : {}),
    createdAt: row.createdAt as string,
  };
}
