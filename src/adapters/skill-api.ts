import type { SkillPack } from "../domain/skill-pack.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { InstallGitReq, InstallPasteReq, SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

export interface SkillApiDeps {
  packStore: SkillPackStore;
  installer: SkillInstaller;
  credentialStore: CredentialStore;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

/** Pack 视图：含 skills + 凭证声明的"已配置"状态。 */
async function packView(
  d: SkillApiDeps,
  userId: string,
  pack: SkillPack,
): Promise<Record<string, unknown>> {
  const skills = await d.packStore.listSkills(userId, pack.id);
  const vaultKeys = new Set((await d.credentialStore.list(userId)).map((e) => e.key));
  return {
    ...pack,
    skills,
    credentials: pack.credentials.map((c) => ({ ...c, configured: vaultKeys.has(c.key) })),
  };
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
      pack = await d.installer.installFromGit(userId, src as unknown as InstallGitReq);
    } else if (src.kind === "paste") {
      pack = await d.installer.installFromPaste(userId, src as unknown as InstallPasteReq);
    } else {
      return { status: 400, json: { error: `不支持的来源: ${src.kind}` } };
    }
  } catch (e) {
    return { status: 400, json: { error: (e as Error).message } };
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
    return { status: 200, json: { pack: await packView(d, userId, pack) } };
  } catch (e) {
    return { status: 400, json: { error: (e as Error).message } };
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
    return { status: 400, json: { error: (e as Error).message } };
  }
}

export async function handleSetPackEnabled(
  userId: string,
  body: { id: string; enabled: boolean },
  d: SkillApiDeps,
): Promise<ApiResult> {
  await d.packStore.setPackEnabled(userId, body.id, body.enabled);
  return { status: 200, json: { ok: true } };
}

export async function handleSetSkillEnabled(
  userId: string,
  body: { id: string; enabled: boolean },
  d: SkillApiDeps,
): Promise<ApiResult> {
  await d.packStore.setSkillEnabled(userId, body.id, body.enabled);
  return { status: 200, json: { ok: true } };
}

export async function handleUninstall(
  userId: string,
  body: { id: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  try {
    await d.installer.uninstall(userId, body.id);
    return { status: 200, json: { ok: true } };
  } catch (e) {
    return { status: 400, json: { error: (e as Error).message } };
  }
}

export async function handleListCredentials(
  userId: string,
  _body: unknown,
  d: SkillApiDeps,
): Promise<ApiResult> {
  const entries = await d.credentialStore.list(userId);
  const packs = await d.packStore.listPacks(userId);
  const usedBy: Record<string, string[]> = {};
  for (const p of packs) {
    for (const c of p.credentials) (usedBy[c.key] ??= []).push(p.name);
  }
  return {
    status: 200,
    json: { credentials: entries.map((e) => ({ ...e, usedBy: usedBy[e.key] ?? [] })) },
  };
}

export async function handleSetCredential(
  userId: string,
  body: { key: string; value: string; label?: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  if (!body.key || typeof body.value !== "string") {
    return { status: 400, json: { error: "缺少 key/value" } };
  }
  await d.credentialStore.setValue(userId, body.key, body.value, body.label);
  return { status: 200, json: { ok: true } };
}

export async function handleDeleteCredential(
  userId: string,
  body: { key: string },
  d: SkillApiDeps,
): Promise<ApiResult> {
  await d.credentialStore.deleteValue(userId, body.key);
  return { status: 200, json: { ok: true } };
}
