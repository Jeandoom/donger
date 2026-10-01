import type { Database } from "better-sqlite3";
import type {
  CredentialTemplate,
  CredentialTemplateInput,
  CredentialValueEntry,
} from "../domain/credential.js";
import type { CredentialSetStore, CredentialTemplateQuery } from "../ports/credential-set-store.js";
import { createSecretCipher, type SecretCipher } from "../util/secret-cipher.js";
import { decryptValue } from "../util/skill-crypto.js";

interface TemplateRow {
  code: string;
  name: string;
  description: string | null;
  kind: string | null;
  repoUrl: string | null;
  keySpecsJson: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ValueRow {
  userId: string;
  code: string;
  name: string | null;
  valuesCipher: string;
  createdAt: string;
  updatedAt: string;
}

export class SqliteCredentialSetStore implements CredentialSetStore {
  constructor(
    private readonly db: Database,
    /** 系统密钥 cipher（2026-09-30 起与 MCP/模型密钥统一为一把系统密钥） */
    private readonly cipher: SecretCipher,
    /** 统一前旧格式（skill-crypto iv:tag:ct）的兜底 keyHex：双读容忍，migrate 一并重加密收编 */
    private readonly legacyKeyHex: string,
  ) {}

  /** 便捷构造（测试/脚本）：seed 派生 cipher、legacyKeyHex 缺省同 seed；生产装配见 index.ts（系统密钥） */
  static fromSeed(db: Database, seed: string): SqliteCredentialSetStore {
    return new SqliteCredentialSetStore(db, createSecretCipher(seed), seed);
  }

  migrate(): void {
    // 全局模板：结构元数据（code 全局唯一，管理权归创建人），不含任何值
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_templates (
        code        TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        kind        TEXT NOT NULL DEFAULT 'generic',
        repoUrl     TEXT,
        keySpecsJson TEXT NOT NULL,
        createdBy   TEXT NOT NULL,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
    `);
    // 旧库无 kind 列 → 补列（git 类凭证不注入 env，规格 2026-09-09-git-platform-tools-design）
    const cols = this.db.prepare("PRAGMA table_info(credential_templates)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "kind")) {
      this.db.exec(
        "ALTER TABLE credential_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic'",
      );
    }
    if (!cols.some((c) => c.name === "repoUrl")) {
      this.db.exec("ALTER TABLE credential_templates ADD COLUMN repoUrl TEXT");
    }
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
    // 旧库无 name 列 → 补列（用户自定显示名/别名，明文非敏感，不进密文）
    const valueCols = this.db.prepare("PRAGMA table_info(user_credential_values)").all() as Array<{
      name: string;
    }>;
    if (!valueCols.some((c) => c.name === "name")) {
      this.db.exec("ALTER TABLE user_credential_values ADD COLUMN name TEXT");
    }
    // 旧单值凭证体系（pack 声明式）已移除；表为空，直接删除
    this.db.exec("DROP TABLE IF EXISTS user_credentials;");
    this.migrateLegacySkillCrypto();
  }

  /** 统一迁移（幂等）：skill-crypto 旧格式（iv:tag:ct，无 v1: 前缀）→ 系统密钥 v1: 格式 */
  private migrateLegacySkillCrypto(): void {
    const rows = this.db
      .prepare(
        "SELECT userId, code, valuesCipher FROM user_credential_values WHERE valuesCipher NOT LIKE 'v1:%'",
      )
      .all() as Array<{ userId: string; code: string; valuesCipher: string }>;
    for (const r of rows) {
      try {
        const plain = decryptValue(this.legacyKeyHex, r.valuesCipher);
        this.db
          .prepare(
            "UPDATE user_credential_values SET valuesCipher = ? WHERE userId = ? AND code = ?",
          )
          .run(this.cipher.encrypt(plain), r.userId, r.code);
      } catch {
        // 毒数据/旧密钥丢失：留待读路径按损坏项跳过，不阻断启动
      }
    }
  }

  /** 双读：v1: 走系统密钥，否则按统一前旧格式（skill-crypto）兜底 */
  private decryptValuesBlob(blob: string): string {
    if (blob.startsWith("v1:")) return this.cipher.decrypt(blob);
    return decryptValue(this.legacyKeyHex, blob);
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
        `INSERT INTO credential_templates (code,name,description,kind,repoUrl,keySpecsJson,createdBy,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        code,
        input.name,
        input.description ?? null,
        input.kind ?? "generic",
        input.repoUrl ?? null,
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
         SET name=?, description=?, kind=?, repoUrl=?, keySpecsJson=?, updatedAt=?
         WHERE code=?`,
      )
      .run(
        input.name,
        input.description ?? null,
        input.kind ?? "generic",
        input.repoUrl ?? null,
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
          name: r.name ?? undefined,
          values: JSON.parse(this.decryptValuesBlob(r.valuesCipher)) as Record<string, string>,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      } catch {
        // 跳过损坏项（密钥轮换等），不阻断其余凭证
      }
    }
    return out;
  }

  // 合并语义：新值覆盖同键、未提及的既有键保留。值不回显，前端「补填缺失键」
  // 只提交新键；整体清除走 DELETE。损坏密文（密钥轮换等）按空值处理。
  async upsertValue(
    userId: string,
    code: string,
    values: Record<string, string>,
    name?: string,
  ): Promise<void> {
    const existing = (await this.getFilledValues(userId, [code]))[0]?.values ?? {};
    const ct = this.cipher.encrypt(JSON.stringify({ ...existing, ...values }));
    this.db
      .prepare(
        `INSERT INTO user_credential_values (userId,code,name,valuesCipher,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(userId,code) DO UPDATE SET
           valuesCipher=excluded.valuesCipher, updatedAt=excluded.updatedAt,
           name=COALESCE(excluded.name, name)`,
      )
      .run(userId, code, name ?? null, ct, new Date().toISOString(), new Date().toISOString());
  }

  async renameValue(userId: string, code: string, name: string): Promise<boolean> {
    const res = this.db
      .prepare(
        "UPDATE user_credential_values SET name = ?, updatedAt = ? WHERE userId = ? AND code = ?",
      )
      .run(name, new Date().toISOString(), userId, code);
    return res.changes > 0;
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
      kind: r.kind === "git" ? "git" : r.kind === "host" ? "host" : "generic",
      repoUrl: r.repoUrl ?? undefined,
      keySpecs: JSON.parse(r.keySpecsJson),
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
