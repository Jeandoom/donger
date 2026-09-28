import type { Database } from "better-sqlite3";
import type { Connector, ConnectorInput } from "../domain/connector.js";
import { ConnectorInputSchema, parseConnector } from "../domain/connector.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import { NotFoundError } from "../util/errors.js";
import type { SecretCipher } from "../util/secret-cipher.js";

/** 持久化形态：headers 是加密后的字符串（而非 Record） */
type PersistedConnector = Omit<Connector, "headers"> & { headers: string };

interface ConnectorRow {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  shareScope: string;
  enabled: number;
  data: string;
  createdAt: string;
  updatedAt: string;
}

export class SqliteConnectorStore implements ConnectorStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  migrate(): void {
    // 标量列支撑列表查询与唯一索引；data 为整包 JSON（headers 是密文），与 agents 表同款双轨
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        shareScope TEXT NOT NULL DEFAULT 'private',
        enabled INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    // 名称唯一域 = owner 私有域（不同用户同名 private 互不冲突；agent 引用集内的重名由服务层硬拦）
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_owner_name ON connectors(ownerId, name)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_connectors_share ON connectors(shareScope) WHERE shareScope = 'global'",
    );
  }

  async listForUser(userId: string): Promise<Connector[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM connectors WHERE ownerId = ? OR shareScope = 'global' ORDER BY updatedAt DESC",
      )
      .all(userId) as ConnectorRow[];
    return rows.map((r) => this.unmarshal(r.data)).filter((c) => c !== null);
  }

  async listByIds(ids: string[]): Promise<Connector[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM connectors WHERE id IN (${placeholders})`)
      .all(...ids) as ConnectorRow[];
    return rows.map((r) => this.unmarshal(r.data)).filter((c) => c !== null);
  }

  async getById(id: string): Promise<Connector | undefined> {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as
      | ConnectorRow
      | undefined;
    return row ? (this.unmarshal(row.data) ?? undefined) : undefined;
  }

  async getByOwnerAndName(ownerId: string, name: string): Promise<Connector | undefined> {
    const row = this.db
      .prepare("SELECT * FROM connectors WHERE ownerId = ? AND name = ?")
      .get(ownerId, name) as ConnectorRow | undefined;
    return row ? (this.unmarshal(row.data) ?? undefined) : undefined;
  }

  async create(input: ConnectorInput, ownerId: string): Promise<Connector> {
    const now = new Date().toISOString();
    // parse 兜底校验——非法数据一旦写入，读路径 unmarshal 会让整个列表 500
    const parsed = ConnectorInputSchema.parse(input);
    const connector: Connector = parseConnector({
      ...parsed,
      id: `conn_${crypto.randomUUID()}`,
      ownerId,
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO connectors (id,ownerId,name,url,shareScope,enabled,data,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        connector.id,
        connector.ownerId,
        connector.name,
        connector.url,
        connector.shareScope,
        connector.enabled ? 1 : 0,
        this.marshal(connector),
        connector.createdAt,
        connector.updatedAt,
      );
    return connector;
  }

  async update(id: string, input: ConnectorInput): Promise<Connector> {
    const cur = await this.getById(id);
    if (!cur) throw new NotFoundError("CONNECTOR_NOT_FOUND", `连接器不存在: ${id}`);
    const parsed = ConnectorInputSchema.parse(input);
    const next: Connector = parseConnector({
      ...parsed,
      // PATCH 未带 type 时沿用存量值（缺省语义在入参层是 optional，这里显式兜底）
      type: parsed.type ?? cur.type,
      id: cur.id,
      ownerId: cur.ownerId,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const res = this.db
      .prepare(
        `UPDATE connectors
         SET name=?, url=?, shareScope=?, enabled=?, data=?, updatedAt=?
         WHERE id=?`,
      )
      .run(
        next.name,
        next.url,
        next.shareScope,
        next.enabled ? 1 : 0,
        this.marshal(next),
        next.updatedAt,
        id,
      );
    if (res.changes === 0) throw new NotFoundError("CONNECTOR_NOT_FOUND", `连接器不存在: ${id}`);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  }

  /** 加密 headers 后序列化；损坏行读路径跳过（毒数据不放大为整列表 500） */
  private marshal(c: Connector): string {
    const safe: PersistedConnector = {
      ...c,
      headers: this.cipher.encrypt(JSON.stringify(c.headers)),
    };
    return JSON.stringify(safe);
  }

  private unmarshal(data: string): Connector | null {
    try {
      const raw = JSON.parse(data) as PersistedConnector;
      return parseConnector({ ...raw, headers: JSON.parse(this.cipher.decrypt(raw.headers)) });
    } catch {
      // 密钥轮换/毒数据：跳过损坏项，不阻断其余连接器
      return null;
    }
  }
}
