// 技能模块领域类型（纯数据）。持久化时 source/credentials 序列化为 JSON。
// 加载由 Claude Agent SDK 原生完成；donger 只持元数据。

export type SkillPackSource =
  | { kind: "git"; url: string; ref?: string; subPath?: string }
  | { kind: "upload"; originalFilename: string }
  | { kind: "paste" }
  | { kind: "builtin" };

/** 凭证声明（需求侧，来自 donger.manifest.json）。值在用户保险柜（CredentialStore）。 */
export interface SkillCredentialSpec {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  secret: boolean;
}

/** Pack = 安装单元（对应 Claude plugin）。 */
export interface SkillPack {
  id: string;
  userId: string;
  slug: string; // 目录名 + 唯一标识；校验 ^[a-z0-9-]+$
  name: string; // plugin.json name（= SDK 白名单前缀）
  description?: string;
  version?: string;
  source: SkillPackSource;
  installedPath: string; // 用户 pack=相对 homeDir；预装=共享绝对路径
  enabled: boolean;
  builtin: boolean;
  credentials: SkillCredentialSpec[];
  createdAt: string;
  updatedAt: string;
}

/** Skill = 激活单元（来自 SKILL.md 扫描）。 */
export interface PackSkill {
  id: string;
  userId: string;
  packId: string;
  name: string; // SKILL.md frontmatter name
  description: string;
  allowedTools?: string[];
  relativePath: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
