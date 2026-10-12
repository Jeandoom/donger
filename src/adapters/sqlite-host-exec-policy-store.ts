import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { HostExecPolicyInput, HostExecPolicyRule } from "../domain/host-exec-policy.js";
import type { HostExecPolicyStore } from "../ports/host-exec-policy-store.js";

type Row = Record<string, unknown>;

/** host_exec_policies 表（specs/2026-10-12-host-exec-policy-design.md §5.1） */
export class SqliteHostExecPolicyStore implements HostExecPolicyStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_exec_policies (
        id TEXT PRIMARY KEY,
        hostCode TEXT NOT NULL,
        tool TEXT NOT NULL DEFAULT 'host_exec',
        scopeKind TEXT NOT NULL,
        scopeRef TEXT,
        matchKind TEXT NOT NULL,
        matchValue TEXT NOT NULL,
        decision TEXT NOT NULL,
        unattended TEXT NOT NULL DEFAULT 'inherit',
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        createdBy TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  async list(): Promise<HostExecPolicyRule[]> {
    const rows = this.db
      .prepare("SELECT * FROM host_exec_policies ORDER BY createdAt, id")
      .all() as Row[];
    return rows.map((r) => this.rowToRule(r));
  }

  async get(id: string): Promise<HostExecPolicyRule | undefined> {
    const r = this.db.prepare("SELECT * FROM host_exec_policies WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? this.rowToRule(r) : undefined;
  }

  async create(
    input: HostExecPolicyInput,
    opts?: { createdBy?: string; note?: string },
  ): Promise<HostExecPolicyRule> {
    const now = new Date().toISOString();
    const rule: HostExecPolicyRule = {
      id: randomUUID(),
      hostCode: input.hostCode,
      tool: input.tool,
      scopeKind: input.scopeKind,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      matchKind: input.matchKind,
      matchValue: input.matchValue,
      decision: input.decision,
      unattended: input.unattended,
      enabled: true,
      ...((opts?.note ?? input.note) ? { note: opts?.note ?? input.note } : {}),
      ...(opts?.createdBy ? { createdBy: opts.createdBy } : {}),
      createdAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO host_exec_policies
         (id,hostCode,tool,scopeKind,scopeRef,matchKind,matchValue,decision,unattended,enabled,note,createdBy,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rule.id,
        rule.hostCode,
        rule.tool,
        rule.scopeKind,
        rule.scopeRef ?? null,
        rule.matchKind,
        rule.matchValue,
        rule.decision,
        rule.unattended,
        1,
        rule.note ?? null,
        rule.createdBy ?? null,
        now,
        now,
      );
    return rule;
  }

  async update(id: string, input: HostExecPolicyInput): Promise<HostExecPolicyRule | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    this.db
      .prepare(
        `UPDATE host_exec_policies SET
           hostCode=?, tool=?, scopeKind=?, scopeRef=?, matchKind=?, matchValue=?,
           decision=?, unattended=?, note=?, updatedAt=?
         WHERE id=?`,
      )
      .run(
        input.hostCode,
        input.tool,
        input.scopeKind,
        input.scopeRef ?? null,
        input.matchKind,
        input.matchValue,
        input.decision,
        input.unattended,
        input.note ?? existing.note ?? null,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<HostExecPolicyRule | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    this.db
      .prepare("UPDATE host_exec_policies SET enabled = ?, updatedAt = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const r = this.db.prepare("DELETE FROM host_exec_policies WHERE id = ?").run(id);
    return r.changes > 0;
  }

  private rowToRule(r: Row): HostExecPolicyRule {
    return {
      id: r.id as string,
      hostCode: r.hostCode as string,
      tool: (r.tool as HostExecPolicyRule["tool"]) ?? "host_exec",
      scopeKind: r.scopeKind as HostExecPolicyRule["scopeKind"],
      scopeRef: (r.scopeRef as string) ?? undefined,
      matchKind: r.matchKind as HostExecPolicyRule["matchKind"],
      matchValue: r.matchValue as string,
      decision: r.decision as HostExecPolicyRule["decision"],
      unattended: (r.unattended as HostExecPolicyRule["unattended"]) ?? "inherit",
      enabled: r.enabled === 1,
      note: (r.note as string) ?? undefined,
      createdBy: (r.createdBy as string) ?? undefined,
      createdAt: r.createdAt as string,
    };
  }
}
