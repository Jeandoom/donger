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
}
