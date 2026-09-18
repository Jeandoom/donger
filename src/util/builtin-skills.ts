import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanSkillPack } from "../domain/skill-scan.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

/**
 * 首次访问时把 BUILTIN_SKILLS_DIR 下每个子目录登记为用户的预装 Pack（幂等）。
 * - 已登记的（按 slug）跳过；
 * - 空目录（无 SKILL.md）跳过；
 * - 预装 Pack 的 installedPath 指向共享只读路径，不为每用户拷贝。
 */
export async function seedBuiltinPacksIfAbsent(
  store: SkillPackStore,
  installer: SkillInstaller,
  builtinDir: string,
  userId: string,
): Promise<void> {
  if (!builtinDir || !existsSync(builtinDir)) return;
  const existing = (await store.listPacks(userId)).filter((p) => p.builtin);
  const registered = new Set(existing.map((p) => p.slug));
  let entries: string[];
  try {
    entries = readdirSync(builtinDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (registered.has(entry)) continue;
    const abs = join(builtinDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (scanSkillPack(abs).skills.length === 0) continue;
    try {
      await installer.installBuiltin(userId, entry, abs);
    } catch (e) {
      // 单个预装失败不阻断其余
      console.error(`[builtin-skills] 预装 ${entry} 失败:`, (e as Error).message);
    }
  }
}
