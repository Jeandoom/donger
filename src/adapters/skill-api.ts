import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePackDirectory } from "../domain/skill-availability.js";
import type { SkillPack } from "../domain/skill-pack.js";
import { parseFrontmatter } from "../domain/skill-scan.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { InstallGitReq, InstallPasteReq, SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import { SkillInstallError } from "../util/errors.js";
import {
  agentWorkspaceSkillsDir,
  buildSkillInventory,
  type SkillInventoryDeps,
} from "./skill-inventory.js";

export interface SkillApiDeps {
  packStore: SkillPackStore;
  installer: SkillInstaller;
  /** 用户技能仓库同步（自建 pack 变更后镜像到用户 git 仓库）；缺省=不同步 */
  skillRepoSync?: { onChanged(userId: string): void };
  /** 全量清单/agent 级安装（specs/2026-10-09-skills-git-hosting-design.md）；缺省=清单仅 packs 源不可用 */
  agentStore?: AgentStore;
  getHomeDir?: (userId: string) => Promise<string>;
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

// ---- 全量清单 / agent 级落点 / 提升托管（specs/2026-10-09-skills-git-hosting-design.md §3.3/§3.4）----

/** GET /api/skills/inventory —— packs ∪ agent 工作区 ∪ 托管标记 三源归一 */
export async function handleInventory(
  userId: string,
  _body: unknown,
  d: SkillApiDeps,
): Promise<ApiResult> {
  if (!d.agentStore || !d.getHomeDir) {
    return { status: 200, json: { records: [], repo: { configured: false, hostedSlugs: [] } } };
  }
  const inventoryDeps: SkillInventoryDeps = {
    packStore: d.packStore,
    agentStore: d.agentStore,
    getHomeDir: d.getHomeDir,
  };
  return { status: 200, json: await buildSkillInventory(inventoryDeps, userId) };
}

/** 安装到 agent 工作区（skills.sh 的 project 级语义）：复制技能目录到 <agent>/workspace/.agents/skills */
export async function handleInstallToAgent(
  userId: string,
  body: {
    agentId?: unknown;
    from?: unknown;
    overwrite?: unknown;
  },
  d: SkillApiDeps,
): Promise<ApiResult> {
  const owned = await ownedAgent(d, userId, body.agentId);
  if ("error" in owned) return owned.error;
  if (!d.getHomeDir) return { status: 500, json: { error: "homeDir 解析不可用" } };
  const homeDir = await d.getHomeDir(userId);
  if (!homeDir) return { status: 500, json: { error: "用户 homeDir 缺失" } };

  const from = (body.from ?? {}) as Record<string, unknown>;
  const skillsRoot = agentWorkspaceSkillsDir(homeDir, owned.agent.id);
  let skillName: string;
  let sourceDir: string | undefined;
  let docContent: string | undefined;
  if (from.kind === "pack") {
    if (typeof from.packId !== "string" || typeof from.skill !== "string") {
      return { status: 400, json: { error: "from.packId/from.skill 必填" } };
    }
    const pack = await d.packStore.getPack(userId, from.packId);
    if (!pack) return { status: 404, json: { error: "技能包不存在" } };
    const skills = await d.packStore.listSkills(userId, pack.id);
    const skill = skills.find((s) => s.name === from.skill);
    if (!skill) return { status: 404, json: { error: `技能不存在: ${from.skill}` } };
    skillName = skill.name;
    sourceDir = dirname(join(resolvePackDirectory(pack, homeDir), skill.relativePath));
  } else if (from.kind === "content") {
    if (typeof from.content !== "string" || !from.content.trim()) {
      return { status: 400, json: { error: "from.content 必填" } };
    }
    const fm = parseFrontmatter(from.content);
    const parsed = validSkillName(typeof from.name === "string" && from.name ? from.name : fm.name);
    if (!parsed) return { status: 400, json: { error: "技能名非法（frontmatter name）" } };
    skillName = parsed;
    docContent = from.content;
  } else {
    return { status: 400, json: { error: "from.kind 仅支持 pack|content" } };
  }

  const targetDir = join(skillsRoot, skillName);
  if (existsSync(join(targetDir, "SKILL.md")) && body.overwrite !== true) {
    return {
      status: 409,
      json: { error: `该 agent 已有同名技能: ${skillName}`, code: "SKILL_EXISTS" },
    };
  }
  mkdirSync(targetDir, { recursive: true });
  if (sourceDir) {
    cpSync(sourceDir, targetDir, { recursive: true });
  } else if (docContent) {
    writeDocSync(targetDir, docContent);
  }
  return {
    status: 200,
    json: {
      ok: true,
      installed: { agentId: owned.agent.id, name: skillName, id: `agent-skills:${skillName}` },
    },
  };
}

/** 提升托管：agent 工作区技能 → user 级 paste pack（slug=技能名；已存在则更新）→ 自动进入镜像 push */
export async function handleHostSkill(
  userId: string,
  body: { agentId?: unknown; skill?: unknown },
  d: SkillApiDeps,
): Promise<ApiResult> {
  const owned = await ownedAgent(d, userId, body.agentId);
  if ("error" in owned) return owned.error;
  const skillName = validSkillName(typeof body.skill === "string" ? body.skill : undefined);
  if (!skillName) return { status: 400, json: { error: "skill 名非法" } };
  if (!d.getHomeDir) return { status: 500, json: { error: "homeDir 解析不可用" } };
  const homeDir = await d.getHomeDir(userId);
  const docPath = join(agentWorkspaceSkillsDir(homeDir, owned.agent.id), skillName, "SKILL.md");
  if (!existsSync(docPath)) {
    return { status: 404, json: { error: `工作区技能不存在: ${skillName}` } };
  }
  const content = readFileSync(docPath, "utf8");
  const fm = parseFrontmatter(content);
  const description = typeof fm.description === "string" ? fm.description : "";

  const existing = await d.packStore.getPackBySlug(userId, skillName);
  try {
    if (!existing) {
      const pack = await d.installer.installFromPaste(userId, {
        content,
        slug: skillName,
        name: skillName,
        description,
      });
      d.skillRepoSync?.onChanged(userId);
      return { status: 200, json: { ok: true, action: "created", packSlug: pack.slug } };
    }
    if (existing.source.kind !== "paste" && existing.source.kind !== "upload") {
      return {
        status: 409,
        json: {
          error: `同名 pack「${existing.slug}」由 ${existing.source.kind} 源管理，不可覆盖托管`,
          code: "PACK_NOT_HOSTABLE",
        },
      };
    }
    await d.installer.updateSkillDoc(userId, existing.id, skillName, content);
    d.skillRepoSync?.onChanged(userId);
    return { status: 200, json: { ok: true, action: "updated", packSlug: existing.slug } };
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

/** 归属校验：agent 必须存在且属于当前用户（agent 级目录在本人 homeDir 下，v1 不开放跨用户安装） */
async function ownedAgent(
  d: SkillApiDeps,
  userId: string,
  agentId: unknown,
): Promise<{ agent: { id: string; name: string } } | { error: ApiResult }> {
  if (!d.agentStore) return { error: { status: 500, json: { error: "agentStore 未装配" } } };
  if (typeof agentId !== "string" || !agentId) {
    return { error: { status: 400, json: { error: "agentId 必填" } } };
  }
  const agent = await d.agentStore.get(agentId);
  if (!agent || agent.ownerId !== userId) {
    return { error: { status: 404, json: { error: "agent 不存在" } } };
  }
  return { agent };
}

function validSkillName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ? name : undefined;
}

function writeDocSync(targetDir: string, content: string): void {
  writeFileSync(join(targetDir, "SKILL.md"), content, "utf8");
}
