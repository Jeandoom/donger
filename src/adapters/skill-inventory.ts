// 技能全量清单（specs/2026-10-09-skills-git-hosting-design.md §3.4）：
// 三源归一视图 = packs（DB 四源）∪ agent 工作区技能（.agents/skills 有界扫描）∪ 托管标记
// （个人技能仓库 manifest）。无状态扫描即视图，不建索引表——拍板 D2：agent 级技能不设
// 独立启停，文件系统即事实源；拍板 D1：托管=单仓库，hosted 以仓库 manifest 的 pack slug 为准。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSkillPack } from "../domain/skill-scan.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

export interface SkillInventoryDeps {
  packStore: SkillPackStore;
  agentStore?: AgentStore;
  getHomeDir: (userId: string) => Promise<string>;
}

export interface SkillInventoryRecord {
  /** 白名单口径 id：pack 技能 `<packName>:<skill>`；agent 级 `agent-skills:<skill>` */
  id: string;
  origin: "pack" | "agent";
  /** pack 来源（origin=pack 时）：git/upload/paste/builtin */
  packSource?: string;
  name: string;
  description: string;
  enabled: boolean;
  /** origin=pack：所属 pack */
  packId?: string;
  packSlug?: string;
  /** origin=agent：所属 agent */
  agentId?: string;
  agentName?: string;
  /** 已纳入个人技能仓库镜像（pack 源且 slug 在仓库 manifest 中） */
  hosted: boolean;
  updatedAt?: string;
}

export interface SkillInventoryResult {
  records: SkillInventoryRecord[];
  repo: {
    configured: boolean;
    /** 仓库 manifest 中已镜像的 pack slug（托管事实源） */
    hostedSlugs: string[];
  };
}

/** 组装当前用户的技能全量清单。工作区扫描有界（scanSkillPack 自带深度/条目上限），逐 agent 隔离容错。 */
export async function buildSkillInventory(
  deps: SkillInventoryDeps,
  userId: string,
): Promise<SkillInventoryResult> {
  const homeDir = await deps.getHomeDir(userId);
  const hostedSlugs = readHostedSlugs(homeDir);

  const records: SkillInventoryRecord[] = [];
  const packs = await deps.packStore.listPacks(userId);
  for (const pack of packs) {
    const hosted = hostedSlugs.has(pack.slug);
    for (const skill of await deps.packStore.listSkills(userId, pack.id)) {
      records.push({
        id: `${pack.name}:${skill.name}`,
        origin: "pack",
        packSource: pack.source.kind,
        name: skill.name,
        description: skill.description,
        enabled: pack.enabled && skill.enabled,
        packId: pack.id,
        packSlug: pack.slug,
        hosted,
        updatedAt: pack.updatedAt,
      });
    }
  }

  const agents = (await deps.agentStore?.listByOwner(userId)) ?? [];
  for (const agent of agents) {
    const dir = agentWorkspaceSkillsDir(homeDir, agent.id);
    if (!existsSync(dir)) continue;
    let scanned: ReturnType<typeof scanSkillPack>;
    try {
      scanned = scanSkillPack(dir);
    } catch {
      continue;
    }
    for (const skill of scanned.skills) {
      records.push({
        id: `agent-skills:${skill.name}`,
        origin: "agent",
        name: skill.name,
        description: skill.description,
        enabled: true,
        agentId: agent.id,
        agentName: agent.name,
        hosted: false,
      });
    }
  }

  return {
    records,
    repo: {
      configured: hostedSlugs.size > 0 || existsSync(repoManifestPath(homeDir)),
      hostedSlugs: [...hostedSlugs],
    },
  };
}

/** agent 级技能目录约定（与 skill-creator 落点一致）：<homeDir>/agents/<agentId>/workspace/.agents/skills */
export function agentWorkspaceSkillsDir(homeDir: string, agentId: string): string {
  return join(homeDir, "agents", agentId, "workspace", ".agents", "skills");
}

/** 仓库 manifest（skill-repo-sync 镜像产物）→ 已托管 pack slug 集合 */
function readHostedSlugs(homeDir: string): Set<string> {
  const slugs = new Set<string>();
  const path = repoManifestPath(homeDir);
  if (!existsSync(path)) return slugs;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      packs?: Array<{ slug?: unknown }>;
    };
    for (const p of parsed.packs ?? []) {
      if (typeof p.slug === "string" && p.slug) slugs.add(p.slug);
    }
  } catch {
    // manifest 损坏不阻塞清单（镜像下次同步会重写）
  }
  return slugs;
}

function repoManifestPath(homeDir: string): string {
  return join(homeDir, ".skill-repo-cache", "manifest.json");
}
