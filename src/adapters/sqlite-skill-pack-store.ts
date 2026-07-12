import type { Database } from "better-sqlite3";
import type {
  PackSkill,
  SkillCredentialSpec,
  SkillPack,
  SkillPackSource,
} from "../domain/skill-pack.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

type Row = Record<string, unknown>;

export class SqliteSkillPackStore implements SkillPackStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_packs (
        userId TEXT NOT NULL, id TEXT NOT NULL,
        slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT, version TEXT,
        sourceJson TEXT NOT NULL, installedPath TEXT NOT NULL, enabled INTEGER NOT NULL,
        builtin INTEGER NOT NULL, credentialsJson TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_packs_slug ON skill_packs(userId, slug);
      CREATE TABLE IF NOT EXISTS pack_skills (
        userId TEXT NOT NULL, id TEXT NOT NULL, packId TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT NOT NULL, allowedToolsJson TEXT,
        relativePath TEXT NOT NULL, enabled INTEGER NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, id)
      );
      CREATE INDEX IF NOT EXISTS idx_pack_skills_pack ON pack_skills(userId, packId);
    `);
  }

  async listPacks(userId: string): Promise<SkillPack[]> {
    const rows = this.db.prepare("SELECT * FROM skill_packs WHERE userId = ?").all(userId) as Row[];
    return rows.map((r) => this.rowToPack(r));
  }

  async getPack(userId: string, packId: string): Promise<SkillPack | undefined> {
    const r = this.db
      .prepare("SELECT * FROM skill_packs WHERE userId = ? AND id = ?")
      .get(userId, packId) as Row | undefined;
    return r ? this.rowToPack(r) : undefined;
  }

  async getPackBySlug(userId: string, slug: string): Promise<SkillPack | undefined> {
    const r = this.db
      .prepare("SELECT * FROM skill_packs WHERE userId = ? AND slug = ?")
      .get(userId, slug) as Row | undefined;
    return r ? this.rowToPack(r) : undefined;
  }

  async upsertPack(pack: SkillPack): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO skill_packs
         (userId,id,slug,name,description,version,sourceJson,installedPath,enabled,builtin,credentialsJson,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(userId,id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, description=excluded.description, version=excluded.version,
           sourceJson=excluded.sourceJson, installedPath=excluded.installedPath, enabled=excluded.enabled,
           builtin=excluded.builtin, credentialsJson=excluded.credentialsJson, updatedAt=excluded.updatedAt`,
      )
      .run(
        pack.userId,
        pack.id,
        pack.slug,
        pack.name,
        pack.description ?? null,
        pack.version ?? null,
        JSON.stringify(pack.source),
        pack.installedPath,
        pack.enabled ? 1 : 0,
        pack.builtin ? 1 : 0,
        JSON.stringify(pack.credentials),
        pack.createdAt,
        pack.updatedAt,
      );
  }

  async deletePack(userId: string, packId: string): Promise<void> {
    this.db.prepare("DELETE FROM pack_skills WHERE userId = ? AND packId = ?").run(userId, packId);
    this.db.prepare("DELETE FROM skill_packs WHERE userId = ? AND id = ?").run(userId, packId);
  }

  async listSkills(userId: string, packId: string): Promise<PackSkill[]> {
    const rows = this.db
      .prepare("SELECT * FROM pack_skills WHERE userId = ? AND packId = ?")
      .all(userId, packId) as Row[];
    return rows.map((r) => this.rowToSkill(r));
  }

  async upsertSkills(userId: string, packId: string, skills: PackSkill[]): Promise<void> {
    const del = this.db.prepare("DELETE FROM pack_skills WHERE userId = ? AND packId = ?");
    const ins = this.db.prepare(
      `INSERT INTO pack_skills
       (userId,id,packId,name,description,allowedToolsJson,relativePath,enabled,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(userId,id) DO UPDATE SET
         name=excluded.name, description=excluded.description, allowedToolsJson=excluded.allowedToolsJson,
         relativePath=excluded.relativePath, enabled=excluded.enabled, updatedAt=excluded.updatedAt`,
    );
    const tx = this.db.transaction((rows: PackSkill[]) => {
      del.run(userId, packId);
      for (const s of rows) {
        ins.run(
          userId,
          s.id,
          packId,
          s.name,
          s.description,
          s.allowedTools ? JSON.stringify(s.allowedTools) : null,
          s.relativePath,
          s.enabled ? 1 : 0,
          s.createdAt,
          s.updatedAt,
        );
      }
    });
    tx(skills);
  }

  async setPackEnabled(userId: string, packId: string, enabled: boolean): Promise<void> {
    this.db
      .prepare("UPDATE skill_packs SET enabled = ?, updatedAt = ? WHERE userId = ? AND id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), userId, packId);
  }

  async setSkillEnabled(userId: string, skillId: string, enabled: boolean): Promise<void> {
    this.db
      .prepare("UPDATE pack_skills SET enabled = ?, updatedAt = ? WHERE userId = ? AND id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), userId, skillId);
  }

  async listEnabledSkillsWithPack(
    userId: string,
  ): Promise<Array<{ skill: PackSkill; pack: SkillPack }>> {
    const packs = (await this.listPacks(userId)).filter((p) => p.enabled);
    const out: Array<{ skill: PackSkill; pack: SkillPack }> = [];
    for (const p of packs) {
      const skills = (await this.listSkills(userId, p.id)).filter((s) => s.enabled);
      for (const s of skills) out.push({ skill: s, pack: p });
    }
    return out;
  }

  private rowToPack(r: Row): SkillPack {
    return {
      id: r.id as string,
      userId: r.userId as string,
      slug: r.slug as string,
      name: r.name as string,
      description: (r.description as string) ?? undefined,
      version: (r.version as string) ?? undefined,
      source: JSON.parse(r.sourceJson as string) as SkillPackSource,
      installedPath: r.installedPath as string,
      enabled: r.enabled === 1,
      builtin: r.builtin === 1,
      credentials: JSON.parse(r.credentialsJson as string) as SkillCredentialSpec[],
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }

  private rowToSkill(r: Row): PackSkill {
    return {
      id: r.id as string,
      userId: r.userId as string,
      packId: r.packId as string,
      name: r.name as string,
      description: r.description as string,
      allowedTools: r.allowedToolsJson
        ? (JSON.parse(r.allowedToolsJson as string) as string[])
        : undefined,
      relativePath: r.relativePath as string,
      enabled: r.enabled === 1,
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }
}
