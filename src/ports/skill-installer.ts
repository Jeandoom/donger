import type { SkillPack } from "../domain/skill-pack.js";

export interface InstallGitReq {
  url: string;
  ref?: string;
  subPath?: string;
  slug?: string;
}
export interface InstallUploadReq {
  filename: string;
  content: string;
}
export interface InstallPasteReq {
  content: string;
  slug?: string;
  name?: string;
  description?: string;
}

export interface SkillInstaller {
  installFromGit(userId: string, req: InstallGitReq): Promise<SkillPack>;
  installFromUpload(userId: string, req: InstallUploadReq): Promise<SkillPack>;
  installFromPaste(userId: string, req: InstallPasteReq): Promise<SkillPack>;
  installBuiltin(userId: string, slug: string, absPath: string): Promise<SkillPack>;
  uninstall(userId: string, packId: string): Promise<void>;
  update(userId: string, packId: string): Promise<SkillPack>;
  /** 读取技能 SKILL.md 全文（builtin 只读可读；路径解析与归属校验由实现收口） */
  readSkillDoc(userId: string, packId: string, skillName: string): Promise<string>;
  /**
   * 重写技能 SKILL.md 全文（技能升级写盘路径）。
   * 仅限发起用户名下、非 builtin、非 git 源的 pack；保留各技能启停状态。
   */
  updateSkillDoc(
    userId: string,
    packId: string,
    skillName: string,
    content: string,
  ): Promise<SkillPack>;
}
