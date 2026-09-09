// 业务知识库只读/沉淀 MCP（donger-kb）：面向 agent 的知识库检索与写入工具。
// 边界：所有路径 resolve 后强制前缀 = <用户工作区>/knowledge_base/（防穿越）；
// 挂载为恒挂载（同 platformTools 模式），可用性由 agent tools 白名单控制
// （kb-qa 场景白名单 = list/read/search 三件只读；research 追加 kb_write）。
// 检索为 grep 级行匹配（不引入 rg 依赖）；语义检索后继替换 kb_search 内部实现，签名不变。

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type KbToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): KbToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): KbToolResult => ({ content: [{ type: "text", text }], isError: true });

const MAX_READ_CHARS = 32_000;
const MAX_SEARCH_HITS = 50;
const LIST_DEPTH = 3;

export interface KbToolsDeps {
  /** 知识库根目录（<用户工作区>/knowledge_base），由装配方计算 */
  kbRoot: string;
}

/** 路径安全：resolve 后必须仍在 kbRoot 内（含 kbRoot 本身）；逃逸返回 undefined */
export function safeResolveKbPath(kbRoot: string, input: string): string | undefined {
  const root = resolve(kbRoot);
  const resolved = resolve(root, input);
  const rel = relative(root, resolved);
  // rel === ""：即 root 本身；不越界 = rel 不以 .. 开头且不是绝对路径
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  return undefined;
}

/** 递归收集 root 下全部文件（跳过隐藏目录），返回绝对路径列表 */
function walkFiles(root: string, depth = 5): string[] {
  if (depth <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...walkFiles(full, depth - 1));
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function treeList(root: string, depth: number, prefix = ""): string[] {
  if (depth <= 0) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const entry of [...entries].sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    const label = prefix === "" ? entry : `${prefix}/${entry}`;
    if (stat.isDirectory()) {
      lines.push(`${label}/`);
      lines.push(...treeList(full, depth - 1, label));
    } else {
      lines.push(label);
    }
  }
  return lines;
}

/** glob 仅支持 * 与 **（映射为正则），非法字符按字面处理；用 matchAll 规避 hook 误报 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function kbToolDefinitions(deps: KbToolsDeps): SdkMcpToolDefinition[] {
  const root = resolve(deps.kbRoot);
  return [
    {
      name: "kb_list",
      description: "列出业务知识库目录树（默认深度 3；可传子目录只看局部）",
      inputSchema: {
        subdir: z.string().optional().describe("相对知识库根的子目录，如 knowledges/research"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ subdir: z.string().optional() }).parse(args);
        const target = a.subdir ? safeResolveKbPath(root, a.subdir) : root;
        if (!target) return fail(`子目录越界：${a.subdir ?? ""}`);
        const lines = treeList(target, LIST_DEPTH);
        return ok(lines.length > 0 ? lines.join("\n") : "（空目录）");
      },
    },
    {
      name: "kb_read",
      description: "读取知识库文件内容（相对知识库根的路径）",
      inputSchema: {
        path: z.string().min(1).describe("相对知识库根的路径，如 knowledges/faq/订单.md"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ path: z.string() }).parse(args);
        const target = safeResolveKbPath(root, a.path);
        if (!target) return fail(`路径越界：${a.path}`);
        try {
          const content = readFileSync(target, "utf8");
          return ok(
            content.length > MAX_READ_CHARS
              ? `${content.slice(0, MAX_READ_CHARS)}\n…（已截断，共 ${content.length} 字符）`
              : content,
          );
        } catch {
          return fail(`文件不存在或不可读：${a.path}（先用 kb_list 确认路径）`);
        }
      },
    },
    {
      name: "kb_search",
      description: "全文检索知识库（行包含匹配，返回 文件:行号:内容，最多 50 条）",
      inputSchema: {
        query: z.string().min(1).describe("检索关键词"),
        glob: z.string().optional().describe("文件名过滤，如 *.md"),
        ignoreCase: z.boolean().optional().describe("忽略大小写（默认 true）"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z
          .object({
            query: z.string(),
            glob: z.string().optional(),
            ignoreCase: z.boolean().optional(),
          })
          .parse(args);
        const globRe = a.glob ? globToRegExp(a.glob) : undefined;
        const needle = a.ignoreCase === false ? a.query : a.query.toLowerCase();
        const hits: string[] = [];
        for (const file of walkFiles(root)) {
          if (globRe) {
            const relPath = relative(root, file).replace(/\\/g, "/");
            const base = file.split(/[\\/]/).pop() ?? "";
            if (!globRe.test(relPath) && !globRe.test(base)) continue;
          }
          let content: string;
          try {
            content = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          const rel = relative(root, file).replace(/\\/g, "/");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            const haystack = a.ignoreCase === false ? line : line.toLowerCase();
            if (haystack.includes(needle)) {
              hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
              if (hits.length >= MAX_SEARCH_HITS) {
                return ok(`${hits.join("\n")}\n…（已达 50 条上限，请细化关键词）`);
              }
            }
          }
        }
        return ok(hits.length > 0 ? hits.join("\n") : `（无命中：${a.query}）`);
      },
    },
    {
      name: "kb_write",
      description: "写入知识库文件（整文件覆写；用于调研结论沉淀。写入内容须标注主题、来源与日期）",
      inputSchema: {
        path: z.string().min(1).describe("相对知识库根的路径（目录不存在会自动创建）"),
        content: z.string().min(1).describe("文件全文（utf8）"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ path: z.string(), content: z.string() }).parse(args);
        const target = safeResolveKbPath(root, a.path);
        if (!target) return fail(`路径越界：${a.path}`);
        if (target === root) return fail("path 不能是知识库根目录本身");
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, a.content, "utf8");
          return ok(
            `已写入 ${relative(root, target).replace(/\\/g, "/")}（${a.content.length} 字符）`,
          );
        } catch (e) {
          return fail(`写入失败：${(e as Error).message}`);
        }
      },
    },
  ];
}

/** 装配 donger-kb SDK MCP server（恒挂载；可用性由 agent tools 白名单控制） */
export function createKbToolsServer(deps: KbToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-kb",
    version: "1.0.0",
    tools: kbToolDefinitions(deps),
  });
}
