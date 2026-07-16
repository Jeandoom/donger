import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { SkillCredentialSpec } from "./skill-pack.js";

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
}

/** 最小 frontmatter 解析（SKILL.md frontmatter 为扁平 key:value，无嵌套）。 */
export function parseFrontmatter(md: string): ParsedFrontmatter {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const raw: Record<string, string | undefined> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim() === "---") break;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v === "|" || v === ">") {
      const block: string[] = [];
      for (i += 1; i < lines.length; i++) {
        const continuation = lines[i];
        if (continuation === undefined || continuation.trim() === "---") break;
        if (continuation.trim() !== "" && !/^\s+/.test(continuation)) {
          i -= 1;
          break;
        }
        block.push(continuation.replace(/^\s{2}/, "").trimEnd());
      }
      raw[k] = (v === "|" ? block.join("\n") : block.join(" ")).trim();
      if (lines[i]?.trim() === "---") break;
      continue;
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    raw[k] = v;
  }
  const fm: ParsedFrontmatter = {};
  if (raw.name) fm.name = raw.name;
  if (raw.description) fm.description = raw.description;
  if (raw["allowed-tools"]) {
    fm.allowedTools = raw["allowed-tools"]
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fm;
}

export interface ScannedSkill {
  name: string;
  description: string;
  allowedTools?: string[];
  relativePath: string; // 相对 packDir
}

export interface ScannedPack {
  packMeta: { name: string; description?: string; version?: string };
  skills: ScannedSkill[];
  credentials: SkillCredentialSpec[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".donger-sdk-plugin"]);

/** 递归找 skillRoot 下所有 SKILL.md，解析 frontmatter；元数据仍从 packDir 读取。 */
export function scanSkillPack(packDir: string, skillRoot = packDir): ScannedPack {
  const skills: ScannedSkill[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        visit(abs);
      } else if (entry === "SKILL.md" && st.isFile()) {
        const fm = parseFrontmatter(readFileSync(abs, "utf8"));
        skills.push({
          name: fm.name ?? "unnamed",
          description: fm.description ?? "",
          allowedTools: fm.allowedTools,
          relativePath: relative(packDir, abs).replaceAll("\\", "/"),
        });
      }
    }
  };
  visit(skillRoot);

  let packMeta: ScannedPack["packMeta"] = { name: basename(packDir) };
  const pluginJsonPath = join(packDir, ".claude-plugin", "plugin.json");
  if (existsSync(pluginJsonPath)) {
    try {
      const pj = JSON.parse(readFileSync(pluginJsonPath, "utf8")) as Record<string, unknown>;
      packMeta = {
        name: typeof pj.name === "string" ? pj.name : basename(packDir),
        description: typeof pj.description === "string" ? pj.description : undefined,
        version: typeof pj.version === "string" ? pj.version : undefined,
      };
    } catch {
      packMeta = { name: basename(packDir) };
    }
  }

  let credentials: SkillCredentialSpec[] = [];
  const manifestPath = join(packDir, "donger.manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        credentials?: SkillCredentialSpec[];
      };
      if (Array.isArray(m.credentials)) credentials = m.credentials;
    } catch {
      credentials = [];
    }
  }
  return { packMeta, skills, credentials };
}
