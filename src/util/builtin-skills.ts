import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";

/**
 * 首次访问时把 BUILTIN_SKILLS_DIR 下每个子目录登记为用户的预装 pack（幂等）。
 * T11 替换为真实实现；此处占位保证编译通过。
 */
export async function seedBuiltinPacksIfAbsent(
  _store: SkillPackStore,
  _installer: SkillInstaller,
  _builtinDir: string,
  _userId: string,
): Promise<void> {
  void 0;
}
