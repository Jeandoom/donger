import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * 尽力扫描插件路径下的 skills（<plugin>/skills/<name>/SKILL.md）。
 * 失败/无目录返回 []。仅供编辑器下拉建议；不阻塞创建（前端允许自由输入）。
 */
export function discoverSkills(pluginPaths: string[]): SkillOption[] {
  const out: SkillOption[] = [];
  for (const root of pluginPaths) {
    const skillsDir = join(root, "skills");
    if (!existsSync(skillsDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const md = join(skillsDir, name, "SKILL.md");
      if (!existsSync(md)) continue;
      try {
        const text = readFileSync(md, "utf8");
        const desc = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
        out.push({ id: name, name, description: desc });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

/** SDK 内置工具目录（编辑器白名单候选） */
export const BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
];
