import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * 知识库检索共享实现（agent 工具面 kb_search 与 HTTP 面站内搜索共用）：
 * FTS 影子索引先行过滤 → 命中文件行级定位；0 命中回落 grep 级全文扫描
 * （含 FTS 与内容脱同步的场景，如复制库未回填/外部直改文件）。
 * 同步 IO（原 kb-tools 形态延续）；timeout/limit/depth 兜住大库扫描上限。
 */

export interface KbSearchTarget {
  kbId: string;
  root: string;
}

export interface KbSearchHit {
  kbId: string;
  path: string;
  line: number;
  snippet: string;
}

export interface KbSearchOptions {
  targets: KbSearchTarget[];
  query: string;
  /** 文件名 glob（仅 * 与 **），如 *.md */
  glob?: string;
  ignoreCase?: boolean;
  /** FTS 影子索引检索（kb-fts.search）；缺省跳过 FTS 直接 grep */
  ftsSearch?: (kbIds: readonly string[], query: string) => Array<{ kbId: string; path: string }>;
  limit?: number;
  timeoutMs?: number;
  depth?: number;
}

export interface KbSearchResult {
  total: number;
  truncated: boolean;
  hits: KbSearchHit[];
}

/** glob 仅支持 * 与 **（映射为正则），非法字符按字面处理；用 matchAll 规避 hook 误报 */
export function globToRegExp(glob: string): RegExp {
  const NUL = String.fromCharCode(0);
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, NUL)
    .replace(/\*/g, "[^/]*")
    .replaceAll(NUL, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function searchKbLibraries(options: KbSearchOptions): KbSearchResult {
  const {
    targets,
    query,
    glob,
    ignoreCase = true,
    ftsSearch,
    limit = 50,
    timeoutMs = 2_000,
    depth = 6,
  } = options;
  const globRe = glob ? globToRegExp(glob) : undefined;
  const needle = ignoreCase ? query.toLowerCase() : query;
  const hits: KbSearchHit[] = [];
  const truncatedFlag = { value: false };

  /** 行级定位：读文件原文，产出 {kbId,path,line,snippet} */
  const locateLines = (target: KbSearchTarget, rel: string, full: string): void => {
    if (hits.length >= limit) {
      truncatedFlag.value = true;
      return;
    }
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const hay = ignoreCase ? line.toLowerCase() : line;
      if (hay.includes(needle)) {
        hits.push({
          kbId: target.kbId,
          path: rel,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
        });
        if (hits.length >= limit) {
          truncatedFlag.value = true;
          return;
        }
      }
    }
  };

  // FTS 优先：跳过不含关键词的文件，仅对命中文件做行级定位
  if (ftsSearch) {
    const files = ftsSearch(
      targets.map((t) => t.kbId),
      query,
    );
    for (const f of files) {
      if (hits.length >= limit) break;
      const target = targets.find((t) => t.kbId === f.kbId);
      if (!target) continue;
      const base = f.path.split("/").pop() ?? "";
      if (globRe && !globRe.test(f.path) && !globRe.test(base)) continue;
      locateLines(target, f.path, join(target.root, ...f.path.split("/")));
    }
  }
  // grep 兜底：FTS 未装配或 0 命中（含 FTS 与内容脱同步的场景）
  if (hits.length === 0) {
    const startedAt = Date.now();
    const searchOne = (target: KbSearchTarget, dir: string, depthLeft: number): void => {
      if (depthLeft <= 0 || hits.length >= limit) return;
      if (Date.now() - startedAt > timeoutMs) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= limit) return;
        if (entry.startsWith(".")) continue;
        const full = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          searchOne(target, full, depthLeft - 1);
          continue;
        }
        if (!stat.isFile()) continue;
        const rel = relative(resolve(target.root), full).replace(/\\/g, "/");
        if (globRe && !globRe.test(rel) && !globRe.test(entry)) continue;
        locateLines(target, rel, full);
      }
    };
    for (const target of targets) searchOne(target, resolve(target.root), depth);
  }
  return { total: hits.length, truncated: truncatedFlag.value, hits };
}
