import type { Database } from "better-sqlite3";
import type {
  ReleaseRun,
  ReleaseRunStatus,
  ReleaseRunStore,
} from "../ports/release-run-store.js";
import { NotFoundError } from "../util/errors.js";

interface ReleaseRunRow {
  id: string;
  workflowId: string;
  workflowRunId: string | null;
  feedbackId: string | null;
  repositoryPath: string;
  mrNumber: string;
  mrUrl: string;
  sourceBranch: string;
  headSha: string;
  baseSha: string;
  policyVerdict: string;
  status: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

function unmarshal(row: ReleaseRunRow): ReleaseRun {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowRunId: row.workflowRunId,
    feedbackId: row.feedbackId,
    repositoryPath: row.repositoryPath,
    mrNumber: row.mrNumber,
    mrUrl: row.mrUrl,
    sourceBranch: row.sourceBranch,
    headSha: row.headSha,
    baseSha: row.baseSha,
    policyVerdict: row.policyVerdict,
    status: row.status as ReleaseRunStatus,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteReleaseRunStore implements ReleaseRunStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS release_runs (
        id TEXT PRIMARY KEY,
        workflowId TEXT NOT NULL,
        workflowRunId TEXT,
        feedbackId TEXT,
        repositoryPath TEXT NOT NULL,
        mrNumber TEXT NOT NULL,
        mrUrl TEXT NOT NULL DEFAULT '',
        sourceBranch TEXT NOT NULL DEFAULT '',
        headSha TEXT NOT NULL DEFAULT '',
        baseSha TEXT NOT NULL DEFAULT '',
        policyVerdict TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        detail TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    // 同 MR 终身一行：去重键唯一索引（幂等迁移天然收敛）
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_release_runs_mr ON release_runs(repositoryPath, mrNumber)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_release_runs_wf ON release_runs(workflowId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_release_runs_sha ON release_runs(headSha)");
  }

  async insert(run: ReleaseRun): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO release_runs
         (id, workflowId, workflowRunId, feedbackId, repositoryPath, mrNumber, mrUrl,
          sourceBranch, headSha, baseSha, policyVerdict, status, detail, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.workflowId,
        run.workflowRunId,
        run.feedbackId,
        run.repositoryPath,
        run.mrNumber,
        run.mrUrl,
        run.sourceBranch,
        run.headSha,
        run.baseSha,
        run.policyVerdict,
        run.status,
        run.detail,
        run.createdAt,
        run.updatedAt,
      );
  }

  async get(id: string): Promise<ReleaseRun | undefined> {
    const row = this.db.prepare("SELECT * FROM release_runs WHERE id = ?").get(id) as
      | ReleaseRunRow
      | undefined;
    return row ? unmarshal(row) : undefined;
  }

  async getByMr(repositoryPath: string, mrNumber: string): Promise<ReleaseRun | undefined> {
    const row = this.db
      .prepare("SELECT * FROM release_runs WHERE repositoryPath = ? AND mrNumber = ?")
      .get(repositoryPath, mrNumber) as ReleaseRunRow | undefined;
    return row ? unmarshal(row) : undefined;
  }

  async getByHeadSha(repositoryPath: string, headSha: string): Promise<ReleaseRun | undefined> {
    const row = this.db
      .prepare(
        "SELECT * FROM release_runs WHERE repositoryPath = ? AND lower(headSha) = lower(?) ORDER BY createdAt DESC LIMIT 1",
      )
      .get(repositoryPath, headSha) as ReleaseRunRow | undefined;
    return row ? unmarshal(row) : undefined;
  }

  async listByWorkflow(workflowId: string, limit = 50): Promise<ReleaseRun[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM release_runs WHERE workflowId = ? ORDER BY createdAt DESC LIMIT ?",
      )
      .all(workflowId, limit) as ReleaseRunRow[];
    return rows.map(unmarshal);
  }

  async listAll(limit = 200): Promise<ReleaseRun[]> {
    const rows = this.db
      .prepare("SELECT * FROM release_runs ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as ReleaseRunRow[];
    return rows.map(unmarshal);
  }

  async updateStatus(
    id: string,
    status: ReleaseRunStatus,
    patch?: { detail?: string; policyVerdict?: string },
  ): Promise<void> {
    const cur = this.db.prepare("SELECT id FROM release_runs WHERE id = ?").get(id);
    if (!cur) throw new NotFoundError("RELEASE_RUN_NOT_FOUND", `发布记录不存在: ${id}`);
    this.db
      .prepare(
        "UPDATE release_runs SET status=?, detail=COALESCE(?, detail), policyVerdict=COALESCE(?, policyVerdict), updatedAt=? WHERE id=?",
      )
      .run(status, patch?.detail ?? null, patch?.policyVerdict ?? null, new Date().toISOString(), id);
  }
}
