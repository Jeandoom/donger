import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * 知识库文件树工具（spec §5.1/§7）：内容真源 = <workspaceDir>/kb/<kbId>/ 下的 markdown。
 * 路径安全同 kb-tools 的 safeResolveKbPath（resolve+relative 前缀防穿越）；V1 仅 .md 可读写。
 */

export const KB_TREE_MAX_ENTRIES = 2000;

export function kbRootDir(workspaceDir: string, kbId: string): string {
  return join(resolve(workspaceDir), "kb", kbId);
}

/** 路径安全：resolve 后必须仍在 root 内（含 root 本身）；逃逸返回 undefined */
export function safeResolveKbEntry(root: string, input: string): string | undefined {
  const base = resolve(root);
  const resolved = resolve(base, input);
  const rel = relative(base, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  return undefined;
}

export interface KbTreeEntry {
  name: string;
  /** 库内相对路径（正斜杠），目录以 / 结尾 */
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: KbTreeEntry[];
}

export interface KbTreeResult {
  entries: KbTreeEntry[];
  /** 条目（文件+目录合计）达上限被截断 */
  truncated: boolean;
  total: number;
}

/** 递归目录树（跳过隐藏条目与 assets/ 预留目录），深度默认 8、条目上限 2000 */
export function listKbTree(root: string, depth = 8): KbTreeResult {
  let truncated = false;
  let total = 0;
  const walk = (dir: string, relPrefix: string, level: number): KbTreeEntry[] => {
    if (level <= 0) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: KbTreeEntry[] = [];
    for (const name of [...names].sort((x, y) => x.localeCompare(y))) {
      if (name.startsWith(".") || name === "assets") continue;
      if (total >= KB_TREE_MAX_ENTRIES) {
        truncated = true;
        return out;
      }
      total++;
      const full = join(dir, name);
      const relPath = relPrefix === "" ? name : `${relPrefix}/${name}`;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        out.push({
          name,
          path: `${relPath}/`,
          type: "dir",
          children: walk(full, relPath, level - 1),
        });
      } else if (stat.isFile()) {
        out.push({ name, path: relPath, type: "file", size: stat.size });
      }
    }
    return out;
  };
  return { entries: walk(root, "", depth), truncated, total };
}

const isMarkdownPath = (p: string): boolean => p.toLowerCase().endsWith(".md");

/** 读 markdown 条目；非 .md / 越界 / 不存在返回 undefined（reason 供 404/400 区分） */
export function readKbEntry(
  root: string,
  relPath: string,
): { content: string } | { error: string } {
  if (!isMarkdownPath(relPath)) return { error: "仅支持读取 .md 文件" };
  const target = safeResolveKbEntry(root, relPath);
  if (!target || target === resolve(root)) return { error: `路径越界：${relPath}` };
  try {
    return { content: readFileSync(target, "utf8") };
  } catch {
    return { error: `文件不存在或不可读：${relPath}` };
  }
}

/** 写 markdown 条目（目录自动创建），返回写入的绝对路径；非 .md / 越界抛错由调用方转 400 */
export function writeKbEntry(root: string, relPath: string, content: string): string {
  if (!isMarkdownPath(relPath)) throw new Error("仅支持写入 .md 文件");
  const target = safeResolveKbEntry(root, relPath);
  if (!target || target === resolve(root)) throw new Error(`路径越界：${relPath}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

/** 删除条目（文件或空目录）；越界/不存在抛错。库根本身不可删 */
export function deleteKbEntry(root: string, relPath: string): void {
  const target = safeResolveKbEntry(root, relPath);
  if (!target || target === resolve(root)) throw new Error(`路径越界：${relPath}`);
  rmSync(target, { recursive: true });
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 库目录是否存在（至少含一个条目）；不存在时懒创建 */
export function ensureKbDir(root: string): void {
  mkdirSync(root, { recursive: true });
}

/** 统计库内文件条数（懒算缓存的数据源，跳过隐藏/assets） */
export function countKbEntries(root: string): number {
  let n = 0;
  const walk = (dir: string, level: number): void => {
    if (level <= 0) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "assets") continue;
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, level - 1);
      else if (stat.isFile()) n++;
    }
  };
  walk(root, 8);
  return n;
}
