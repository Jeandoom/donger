import type { Database } from "better-sqlite3";
import type {
  CredentialTemplate,
  CredentialTemplateInput,
  CredentialValueEntry,
} from "../domain/credential.js";
import type { CredentialSetStore, CredentialTemplateQuery } from "../ports/credential-set-store.js";
import { decryptValue, encryptValue } from "../util/skill-crypto.js";

interface TemplateRow {
  code: string;
  name: string;
  description: string | null;
  keySpecsJson: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ValueRow {
  userId: string;
  code: string;
  valuesCipher: string;
  createdAt: string;
  updatedAt: string;
}

export class SqliteCredentialSetStore implements CredentialSetStore {
  constructor(
    private readonly db: Database,
    private readonly keyHex: string,
  ) {}

  migrate(): void {
    // 全局模板：结构元数据（code 全局唯一，管理权归创建人），不含任何值
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_templates (
        code        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        keySpecsJson TEXT NOT NULL,
        createdBy   TEXT NOT NULL,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
    `);
    // 用户值：按 (userId, code) 隔离；负载整体加密，仅注入链路解密
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_credential_values (
        userId       TEXT NOT NULL,
        code         TEXT NOT NULL,
        valuesCipher TEXT NOT NULL,
        createdAt    TEXT NOT NULL,
        updatedAt    TEXT NOT NULL,
        PRIMARY KEY (userId, code)
      );
      CREATE INDEX IF NOT EXISTS idx_ucv_code ON user_credential_values(code);
    `);
    // 旧单值凭证体系（pack 声明式）已移除；表为空，直接删除
    this.db.exec("DROP TABLE IF EXISTS user_credentials;");
  }

  // ---- 模板 ----

  async listTemplates(query: CredentialTemplateQuery): Promise<CredentialTemplate[]> {
    const rows = (await Promise.resolve(
      query.q
        ? this.db
            .prepare(
              `SELECT * FROM credential_templates
               WHERE code LIKE ? OR name LIKE ? OR IFNULL(description,'') LIKE ?
               ORDER BY updatedAt DESC`,
            )
            .all(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`)
        : this.db.prepare("SELECT * FROM credential_templates ORDER BY updatedAt DESC").all(),
    )) as TemplateRow[];
    return rows.map((r) => this.rowToTemplate(r));
  }

  async getTemplate(code: string): Promise<CredentialTemplate | undefined> {
    const row = this.db.prepare("SELECT * FROM credential_templates WHERE code = ?").get(code) as
      | TemplateRow
      | undefined;
    return row ? this.rowToTemplate(row) : undefined;
  }

  async createTemplate(
    code: string,
    input: CredentialTemplateInput,
    createdBy: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO credential_templates (code,name,description,keySpecsJson,createdBy,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        code,
        input.name,
        input.description ?? null,
        JSON.stringify(input.keySpecs),
        createdBy,
        now,
        now,
      );
  }

  async updateTemplate(code: string, input: CredentialTemplateInput): Promise<void> {
    const res = this.db
      .prepare(
        `UPDATE credential_templates
         SET name=?, description=?, keySpecsJson=?, updatedAt=?
         WHERE code=?`,
      )
      .run(
        input.name,
        input.description ?? null,
        JSON.stringify(input.keySpecs),
        new Date().toISOString(),
        code,
      );
    if (res.changes === 0) throw new Error(`凭证模板不存在: ${code}`);
  }

  async countTemplateReferences(code: string): Promise<number> {
    return (
      this.db.prepare("SELECT COUNT(*) n FROM user_credential_values WHERE code = ?").get(code) as {
        n: number;
      }
    ).n;
  }

  async deleteTemplate(code: string): Promise<void> {
    this.db.prepare("DELETE FROM credential_templates WHERE code = ?").run(code);
  }

  // ---- 用户值 ----

  async listValueCodes(userId: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT code FROM user_credential_values WHERE userId = ? ORDER BY code")
      .all(userId) as Array<{ code: string }>;
    return rows.map((r) => r.code);
  }

  async getFilledValues(userId: string, codes: string[]): Promise<CredentialValueEntry[]> {
    if (codes.length === 0) return [];
    const placeholders = codes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM user_credential_values WHERE userId = ? AND code IN (${placeholders})
         ORDER BY createdAt`,
      )
      .all(userId, ...codes) as ValueRow[];
    const out: CredentialValueEntry[] = [];
    for (const r of rows) {
      try {
        out.push({
          userId: r.userId,
          code: r.code,
          values: JSON.parse(decryptValue(this.keyHex, r.valuesCipher)) as Record<string, string>,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      } catch {
        // 跳过损坏项（密钥轮换等），不阻断其余凭证
      }
    }
    return out;
  }

  async upsertValue(userId: string, code: string, values: Record<string, string>): Promise<void> {
    const ct = encryptValue(this.keyHex, JSON.stringify(values));
    this.db
      .prepare(
        `INSERT INTO user_credential_values (userId,code,valuesCipher,createdAt,updatedAt)
         VALUES (?,?,?,?,?)
         ON CONFLICT(userId,code) DO UPDATE SET
           valuesCipher=excluded.valuesCipher, updatedAt=excluded.updatedAt`,
      )
      .run(userId, code, ct, new Date().toISOString(), new Date().toISOString());
  }

  async deleteValue(userId: string, code: string): Promise<void> {
    this.db
      .prepare("DELETE FROM user_credential_values WHERE userId = ? AND code = ?")
      .run(userId, code);
  }

  async countUsersByTemplate(code: string): Promise<number> {
    return this.countTemplateReferences(code);
  }

  private rowToTemplate(r: TemplateRow): CredentialTemplate {
    return {
      code: r.code,
      name: r.name,
      description: r.description ?? undefined,
      keySpecs: JSON.parse(r.keySpecsJson),
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
