import type { PackSkill, SkillPack } from "../domain/skill-pack.js";

export interface SkillPackStore {
  migrate(): void;
  listPacks(userId: string): Promise<SkillPack[]>;
  getPack(userId: string, packId: string): Promise<SkillPack | undefined>;
  getPackBySlug(userId: string, slug: string): Promise<SkillPack | undefined>;
  upsertPack(pack: SkillPack): Promise<void>;
  deletePack(userId: string, packId: string): Promise<void>;
  listSkills(userId: string, packId: string): Promise<PackSkill[]>;
  upsertSkills(userId: string, packId: string, skills: PackSkill[]): Promise<void>;
  setPackEnabled(userId: string, packId: string, enabled: boolean): Promise<void>;
  setSkillEnabled(userId: string, skillId: string, enabled: boolean): Promise<void>;
  /** 一次性返回启用 pack 下启用 skill（带 pack），供运行时装配。 */
  listEnabledSkillsWithPack(userId: string): Promise<Array<{ skill: PackSkill; pack: SkillPack }>>;
}
