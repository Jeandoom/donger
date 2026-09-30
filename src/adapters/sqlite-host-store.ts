// 主机资产 SQLite 存储。建表前已核对全仓 DROP TABLE 清单无撞名。
import type { Database } from "better-sqlite3";
import { type Host, type HostInput, HostSchema } from "../domain/host.js";
import type { HostStore } from "../ports/host-store.js";
import { NotFoundError } from "../util/errors.js";

interface HostRow {
  id: string;
  ownerId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credentialCode: string;
  description: string | null;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

export class SqliteHostStore implements HostStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL,
        name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL, credentialCode TEXT NOT NULL,
        description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_hosts_owner ON hosts(ownerId)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_hosts_enabled ON hosts(enabled)");
  }

  private unmarshal(row: HostRow): Host {
    return HostSchema.parse({
      ...row,
      description: row.description ?? undefined,
      enabled: row.enabled === 1,
    });
  }

  private columns(h: Host) {
    return [
      h.id,
      h.ownerId,
      h.name,
      h.host,
      h.port,
      h.username,
      h.credentialCode,
      h.description ?? null,
      h.enabled ? 1 : 0,
      h.createdAt,
      h.updatedAt,
    ] as const;
  }

  async create(input: HostInput, ownerId: string): Promise<Host> {
    const now = new Date().toISOString();
    const h: Host = HostSchema.parse({
      ...input,
      ownerId,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO hosts (id, ownerId, name, host, port, username, credentialCode, description, enabled, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(...this.columns(h));
    return h;
  }

  async get(id: string): Promise<Host | undefined> {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
    return row ? this.unmarshal(row) : undefined;
  }

  async listHosts(): Promise<Host[]> {
    const rows = this.db.prepare("SELECT * FROM hosts ORDER BY updatedAt DESC").all() as HostRow[];
    return rows.map((r) => this.unmarshal(r));
  }

  async update(id: string, patch: Partial<HostInput>): Promise<Host> {
    const cur = await this.get(id);
    if (!cur) throw new NotFoundError("HOST_NOT_FOUND", `主机不存在: ${id}`);
    const next = HostSchema.parse({
      ...cur,
      ...patch,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE hosts SET name=?, host=?, port=?, username=?, credentialCode=?, description=?, enabled=?, updatedAt=? WHERE id=?`,
      )
      .run(
        next.name,
        next.host,
        next.port,
        next.username,
        next.credentialCode,
        next.description ?? null,
        next.enabled ? 1 : 0,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  }
}
