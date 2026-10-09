import type { SkillPack } from "../domain/skill-pack.js";
import type { InstallGitReq, InstallPasteReq, SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { SkillInstallError } from "../util/errors.js";

export interface SkillApiDeps {
  packStore: SkillPackStore;
  installer: SkillInstaller;
  /** 用户技能仓库同步（自建 pack 变更后镜像到用户 git 仓库）；缺省=不同步 */
  skillRepoSync?: { onChanged(userId: string): void };
}

export interface ApiResult {
  status: number;
  json: unknown;
}

/** Pack 视图：含 skills。 */
async function packView(
  d: SkillApiDeps,
  userId: string,
  pack: SkillPack,
): Promise<Record<string, unknown>> {
  const skills = await d.packStore.listSkills(userId, pack.id);
  return { ...pack, skills };
}

export async function handleListPacks(
  userId: string,
  _body: unknown,
  d: SkillApiDeps,
): Promise<ApiResult> {
  const packs = await d.packStore.listPacks(userId);
  const views = await Promise.all(packs.map((p) => packView(d, userId, p)));
  return { status: 200, json: { packs: views } };
}

export async function handleInstall(
  userId: string,
  body: { source: unknown },
  d: SkillApiDeps,
): Promise<ApiResult> {
  const src = body.source as Record<string, unknown>;
  if (!src || typeof src.kind !== "string") {
    return { status: 400, json: { error: "缺少 source.kind" } };
  }
  let pack: SkillPack;
  try {
    if (src.kind === "git") {
      if (typeof src.url !== "string" || !src.url.trim()) {
        return { status: 400, json: { error: "Git 来源缺少 url" } };
      }
      if (src.subPath !== undefined && typeof src.subPath !== "string") {
        return { status: 400, json: { error: "Git 来源 subPath 必须是字符串" } };
      }
      pack = await d.installer.installFromGit(userId, src as unknown as InstallGitReq);
    } else if (src.kind === "paste") {
      pack = await d.installer.installFromPaste(userId, src as unknown as InstallPasteReq);
      d.skillRepoSync?.onChanged(userId);
    } else {
      return { status: 400, json: { error: `不支持的来源: ${src.kind}` } };
    }
  } catch (e) {
    return {
      status: 400,
      json: {
        error: (e as Error).message,
        code: e instanceof SkillInstallError ? e.code : undefined,
      },
    };
  }
  return { status: 200, json: { pack: await packView(d, userId, pack) } };
}

export async function handleInstallUpload(
  userId: string,
  body: { filename: string; content: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  if (!body.content) return { status: 400, json: { error: "缺少文件内容" } };
  try {
    const pack = await d.installer.installFromUpload(userId, body);
    d.skillRepoSync?.onChanged(userId);
    return { status: 200, json: { pack: await packView(d, userId, pack) } };
  } catch (e) {
    return {
      status: 400,
      json: {
        error: (e as Error).message,
        code: e instanceof SkillInstallError ? e.code : undefined,
      },
    };
  }
}

export async function handleUpdate(
  userId: string,
  body: { id: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  try {
    const pack = await d.installer.update(userId, body.id);
    return { status: 200, json: { pack: await packView(d, userId, pack) } };
  } catch (e) {
    return {
      status: 400,
      json: {
        error: (e as Error).message,
        code: e instanceof SkillInstallError ? e.code : undefined,
      },
    };
  }
}

export async function handleSetPackEnabled(
  userId: string,
  body: { id: string; enabled: boolean },
  d: SkillApiDeps,
): Promise<ApiResult> {
  await d.packStore.setPackEnabled(userId, body.id, body.enabled);
  d.skillRepoSync?.onChanged(userId);
  return { status: 200, json: { ok: true } };
}

export async function handleSetSkillEnabled(
  userId: string,
  body: { id: string; enabled: boolean },
  d: SkillApiDeps,
): Promise<ApiResult> {
  await d.packStore.setSkillEnabled(userId, body.id, body.enabled);
  d.skillRepoSync?.onChanged(userId);
  return { status: 200, json: { ok: true } };
}

export async function handleUninstall(
  userId: string,
  body: { id: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  try {
    await d.installer.uninstall(userId, body.id);
    d.skillRepoSync?.onChanged(userId);
    return { status: 200, json: { ok: true } };
  } catch (e) {
    return {
      status: 400,
      json: {
        error: (e as Error).message,
        code: e instanceof SkillInstallError ? e.code : undefined,
      },
    };
  }
}
