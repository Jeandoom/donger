// 平台技能白名单物化（codex/zcode 引擎共用，specs/2026-10-09-skills-git-hosting-design.md G5）：
// 两引擎都无 claude SDK 的 plugins 直挂通道，改走各自的原生技能目录——
// codex = CODEX_HOME/skills，zcode = <重定向HOME>/.zcode/skills（bundle 实证
// resolveDefaultSkillRoots 的用户级根，目录名即技能名）。
// 白名单语义：仅复制 opts.skills 勾选（packName:skillName）且 pack 启用的技能；
// 单技能失败不阻断运行（缺该技能仅能力降级）。
// 完整性校验（知识体系轮 P1）：description 超 1024 字节会被引擎整体丢弃（G5 实证
// 丢弃线）；正文引用的 scripts/assets 等本地相对路径缺失=技能半失效（生产会话
// 60475bae 实锤：ops-check 引用未随包脚本，agent 现场重写执行器）——命中即跳过
// 物化并回传告警，编辑器侧 agentEquipmentWarnings 同源复用 skillDocIssues。

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanSkillPack } from "../domain/skill-scan.js";

export function materializeWhitelistedSkills(
  skills: string[],
  pluginPaths: string[],
  skillsHome: string,
): string[] {
  const warnings: string[] = [];
  if (skills.length === 0 || pluginPaths.length === 0) return warnings;
  const wanted = new Map<string, Set<string>>();
  for (const id of skills) {
    const sep = id.indexOf(":");
    if (sep <= 0 || sep === id.length - 1) continue;
    const packName = id.slice(0, sep);
    const skillName = id.slice(sep + 1);
    const set = wanted.get(packName) ?? new Set<string>();
    set.add(skillName);
    wanted.set(packName, set);
  }
  if (wanted.size === 0) return warnings;

  for (const pluginPath of pluginPaths) {
    if (!existsSync(pluginPath)) continue;
    const packName = readPluginName(pluginPath);
    const selected = packName ? wanted.get(packName) : undefined;
    if (!selected || selected.size === 0) continue;
    let scanned: ReturnType<typeof scanSkillPack>;
    try {
      scanned = scanSkillPack(pluginPath);
    } catch {
      continue;
    }
    for (const skill of scanned.skills) {
      if (!selected.has(skill.name)) continue;
      const docPath = join(pluginPath, skill.relativePath);
      const issues = skillDocIssues(docPath, skill.description);
      if (issues.length > 0) {
        warnings.push(`${skill.name}: ${issues.join("；")}`);
        continue;
      }
      const sourceDir = join(pluginPath, skill.relativePath, "..");
      const target = join(skillsHome, skill.name);
      rmSync(target, { recursive: true, force: true });
      try {
        cpSync(sourceDir, target, { recursive: true });
      } catch {
        // 单技能物化失败不阻断运行（缺该技能仅能力降级）
      }
    }
  }
  return warnings;
}

/**
 * SKILL.md 完整性校验（P1，物化器与编辑器预警共用）：
 * ① description 超 1024 字节——引擎丢弃线，物化必然无效；
 * ② 正文引用的本地资产相对路径（scripts/ assets/ 等）存在性——缺失即技能半失效。
 */
export function skillDocIssues(docPath: string, description: string | undefined): string[] {
  const issues: string[] = [];
  const descBytes = Buffer.byteLength(description ?? "", "utf8");
  if (descBytes > 1024) {
    issues.push(`description 超 1024 字节（${descBytes}），引擎会整体丢弃该技能`);
  }
  let md: string;
  try {
    md = readFileSync(docPath, "utf8");
  } catch {
    issues.push("SKILL.md 不可读");
    return issues;
  }
  const skillDir = dirname(docPath);
  const missing = new Set<string>();
  for (const ref of extractLocalAssetRefs(md)) {
    if (!existsSync(join(skillDir, ref))) missing.add(ref);
  }
  if (missing.size > 0) issues.push(`引用缺失 ${[...missing].join("、")}`);
  return issues;
}

/**
 * 提取正文中引用的本地资产相对路径（scripts/...、assets/... 等固定前缀目录）。
 * 前缀白名单匹配——http(s) 链接、绝对路径、`<占位符>` 引导语不计入。
 */
export function extractLocalAssetRefs(md: string): string[] {
  const out = new Set<string>();
  // 前置否定环视排除 URL 路径段（https://x/scripts/a）与文件名片段（my-scripts/a）
  for (const m of md.matchAll(
    /(?<![\w/.])(?:scripts|assets|references|templates|examples|files)\/[\w][\w./-]*/g,
  )) {
    const ref = m[0].replace(/[.,;:)\]`]+$/, "");
    if (ref) out.add(ref);
  }
  return [...out];
}

function readPluginName(pluginPath: string): string | undefined {
  const marker = join(pluginPath, ".claude-plugin", "plugin.json");
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
