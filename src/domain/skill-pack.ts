// 技能模块领域类型（纯数据）。持久化时 source 序列化为 JSON。
// 加载由 Claude Agent SDK 原生完成；donger 只持元数据。
// 凭证：旧 pack 声明式单值体系已移除，改由凭证模板 + 用户值 + agent 勾选（domain/credential.ts）。

export type SkillPackSource =
  | {
      kind: "git";
      url: string;
      ref?: string;
      subPath?: string;
      /** 私有仓库鉴权凭证（kind=git 模板 code，仅存引用；更新拉取时复用） */
      credentialCode?: string;
    }
  | { kind: "upload"; originalFilename: string }
  | { kind: "paste" }
  | { kind: "builtin" };

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
