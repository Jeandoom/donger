import type { SkillPack } from "../domain/skill-pack.js";

export interface InstallGitReq {
  url: string;
  ref?: string;
  subPath?: string;
  slug?: string;
  /** 私有仓库鉴权：引用凭证集中 kind=git 模板的 code；缺省=匿名拉取（公开仓库） */
  credentialCode?: string;
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

/**
 * 安装/更新过程钩子（任务化 UI，2026-10 体验轮）：阶段上报供进度展示；
 * signal 触发即取消——git 子进程被 kill，阶段边界处显性抛 CANCELLED。
 */
export interface SkillInstallHooks {
  onStage?(stage: string): void;
  signal?: AbortSignal;
}

export interface SkillInstaller {
  installFromGit(userId: string, req: InstallGitReq, hooks?: SkillInstallHooks): Promise<SkillPack>;
  installFromUpload(userId: string, req: InstallUploadReq): Promise<SkillPack>;
  installFromPaste(userId: string, req: InstallPasteReq): Promise<SkillPack>;
  installBuiltin(userId: string, slug: string, absPath: string): Promise<SkillPack>;
  uninstall(userId: string, packId: string): Promise<void>;
  update(userId: string, packId: string, hooks?: SkillInstallHooks): Promise<SkillPack>;
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
