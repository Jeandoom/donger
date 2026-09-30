// 部署目标/部署单 SQLite 存储。建表前已核对全仓 DROP TABLE 清单无撞名（教训：
// credential-sets 历史 DROP 曾静默删新表）。

import type { Database } from "better-sqlite3";
import {
  type DeployOrder,
  DeployOrderSchema,
  type DeployTarget,
  type DeployTargetInput,
  DeployTargetSchema,
} from "../domain/deploy.js";
import type { DeployStore } from "../ports/deploy-store.js";
import { NotFoundError } from "../util/errors.js";

interface TargetRow {
  id: string;
  ownerId: string;
  name: string;
  service: string;
  provider: string;
  repoUrl: string;
  branch: string;
  gitCredentialCode: string | null;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshCredentialCode: string;
  workdir: string;
  prepareCommands: string;
  restartCommands: string;
  healthCheck: string | null;
  autoDeploy: number;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

interface OrderRow {
  id: string;
  targetId: string;
  trigger: string;
  ref: string | null;
  sha: string | null;
  status: string;
  steps: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export class SqliteDeployStore implements DeployStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deploy_targets (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL,
        name TEXT NOT NULL, service TEXT NOT NULL,
        provider TEXT NOT NULL, repoUrl TEXT NOT NULL, branch TEXT NOT NULL,
        gitCredentialCode TEXT,
        sshHost TEXT NOT NULL, sshPort INTEGER NOT NULL, sshUsername TEXT NOT NULL,
        sshCredentialCode TEXT NOT NULL,
        workdir TEXT NOT NULL,
        prepareCommands TEXT NOT NULL, restartCommands TEXT NOT NULL, healthCheck TEXT,
        autoDeploy INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_deploy_targets_owner ON deploy_targets(ownerId)");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_deploy_targets_enabled ON deploy_targets(enabled)",
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deploy_orders (
        id TEXT PRIMARY KEY, targetId TEXT NOT NULL,
        trigger TEXT NOT NULL, ref TEXT, sha TEXT,
        status TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', error TEXT,
        startedAt TEXT NOT NULL, finishedAt TEXT
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_deploy_orders_target ON deploy_orders(targetId, startedAt DESC)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_deploy_orders_status ON deploy_orders(status)");
  }

  private unmarshalTarget(row: TargetRow): DeployTarget {
    return DeployTargetSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      service: row.service,
      provider: row.provider,
      repoUrl: row.repoUrl,
      branch: row.branch,
      gitCredentialCode: row.gitCredentialCode ?? undefined,
      ssh: {
        host: row.sshHost,
        port: row.sshPort,
        username: row.sshUsername,
        credentialCode: row.sshCredentialCode,
      },
      workdir: row.workdir,
      prepareCommands: JSON.parse(row.prepareCommands),
      restartCommands: JSON.parse(row.restartCommands),
      healthCheck: row.healthCheck ? JSON.parse(row.healthCheck) : undefined,
      autoDeploy: row.autoDeploy === 1,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private unmarshalOrder(row: OrderRow): DeployOrder {
    return DeployOrderSchema.parse({
      id: row.id,
      targetId: row.targetId,
      trigger: row.trigger,
      ref: row.ref ?? undefined,
      sha: row.sha ?? undefined,
      status: row.status,
      steps: JSON.parse(row.steps ?? "[]"),
      error: row.error ?? undefined,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? undefined,
    });
  }

  async createTarget(input: DeployTargetInput, ownerId: string): Promise<DeployTarget> {
    const now = new Date().toISOString();
    const t: DeployTarget = DeployTargetSchema.parse({
      ...input,
      ownerId,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO deploy_targets (id, ownerId, name, service, provider, repoUrl, branch,
         gitCredentialCode, sshHost, sshPort, sshUsername, sshCredentialCode, workdir,
         prepareCommands, restartCommands, healthCheck, autoDeploy, enabled, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.id,
        t.ownerId,
        t.name,
        t.service,
        t.provider,
        t.repoUrl,
        t.branch,
        t.gitCredentialCode ?? null,
        t.ssh.host,
        t.ssh.port,
        t.ssh.username,
        t.ssh.credentialCode,
        t.workdir,
        JSON.stringify(t.prepareCommands),
        JSON.stringify(t.restartCommands),
        t.healthCheck ? JSON.stringify(t.healthCheck) : null,
        t.autoDeploy ? 1 : 0,
        t.enabled ? 1 : 0,
        t.createdAt,
        t.updatedAt,
      );
    return t;
  }

  async getTarget(id: string): Promise<DeployTarget | undefined> {
    const row = this.db.prepare("SELECT * FROM deploy_targets WHERE id = ?").get(id) as
      | TargetRow
      | undefined;
    return row ? this.unmarshalTarget(row) : undefined;
  }

  async listTargets(): Promise<DeployTarget[]> {
    const rows = this.db
      .prepare("SELECT * FROM deploy_targets ORDER BY updatedAt DESC")
      .all() as TargetRow[];
    return rows.map((r) => this.unmarshalTarget(r));
  }

  async listEnabledTargets(): Promise<DeployTarget[]> {
    const rows = this.db
      .prepare("SELECT * FROM deploy_targets WHERE enabled = 1 ORDER BY updatedAt DESC")
      .all() as TargetRow[];
    return rows.map((r) => this.unmarshalTarget(r));
  }

  async updateTarget(id: string, patch: Partial<DeployTargetInput>): Promise<DeployTarget> {
    const cur = await this.getTarget(id);
    if (!cur) throw new NotFoundError("DEPLOY_TARGET_NOT_FOUND", `部署目标不存在: ${id}`);
    const next = DeployTargetSchema.parse({
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE deploy_targets SET name=?, service=?, provider=?, repoUrl=?, branch=?,
         gitCredentialCode=?, sshHost=?, sshPort=?, sshUsername=?, sshCredentialCode=?, workdir=?,
         prepareCommands=?, restartCommands=?, healthCheck=?, autoDeploy=?, enabled=?, updatedAt=?
         WHERE id=?`,
      )
      .run(
        next.name,
        next.service,
        next.provider,
        next.repoUrl,
        next.branch,
        next.gitCredentialCode ?? null,
        next.ssh.host,
        next.ssh.port,
        next.ssh.username,
        next.ssh.credentialCode,
        next.workdir,
        JSON.stringify(next.prepareCommands),
        JSON.stringify(next.restartCommands),
        next.healthCheck ? JSON.stringify(next.healthCheck) : null,
        next.autoDeploy ? 1 : 0,
        next.enabled ? 1 : 0,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  async deleteTarget(id: string): Promise<void> {
    this.db.prepare("DELETE FROM deploy_targets WHERE id = ?").run(id);
  }

  async createOrder(order: Omit<DeployOrder, "finishedAt">): Promise<DeployOrder> {
    const o: DeployOrder = DeployOrderSchema.parse({ ...order, finishedAt: null });
    this.db
      .prepare(
        `INSERT INTO deploy_orders (id, targetId, trigger, ref, sha, status, steps, error, startedAt, finishedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.id,
        o.targetId,
        o.trigger,
        o.ref ?? null,
        o.sha ?? null,
        o.status,
        JSON.stringify(o.steps),
        o.error ?? null,
        o.startedAt,
        null,
      );
    return o;
  }

  async updateOrder(id: string, patch: Partial<DeployOrder>): Promise<void> {
    const cur = await this.getOrder(id);
    if (!cur) throw new NotFoundError("DEPLOY_ORDER_NOT_FOUND", `部署单不存在: ${id}`);
    const next: DeployOrder = { ...cur, ...patch, id: cur.id };
    this.db
      .prepare(
        `UPDATE deploy_orders SET trigger=?, ref=?, sha=?, status=?, steps=?, error=?, finishedAt=? WHERE id=?`,
      )
      .run(
        next.trigger,
        next.ref ?? null,
        next.sha ?? null,
        next.status,
        JSON.stringify(next.steps),
        next.error ?? null,
        next.finishedAt ?? null,
        next.id,
      );
  }

  async getOrder(id: string): Promise<DeployOrder | undefined> {
    const row = this.db.prepare("SELECT * FROM deploy_orders WHERE id = ?").get(id) as
      | OrderRow
      | undefined;
    return row ? this.unmarshalOrder(row) : undefined;
  }

  async listOrders(targetId: string, limit = 20): Promise<DeployOrder[]> {
    const rows = this.db
      .prepare("SELECT * FROM deploy_orders WHERE targetId = ? ORDER BY startedAt DESC LIMIT ?")
      .all(targetId, limit) as OrderRow[];
    return rows.map((r) => this.unmarshalOrder(r));
  }

  async getLastSuccessOrder(targetId: string): Promise<DeployOrder | undefined> {
    const row = this.db
      .prepare(
        "SELECT * FROM deploy_orders WHERE targetId = ? AND status = 'success' ORDER BY startedAt DESC LIMIT 1",
      )
      .get(targetId) as OrderRow | undefined;
    return row ? this.unmarshalOrder(row) : undefined;
  }

  async failRunningOrders(reason: string): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE deploy_orders SET status='failed', error=?, finishedAt=? WHERE status='running'",
      )
      .run(reason, now);
    return result.changes;
  }
}
