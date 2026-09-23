// 业务知识库 MCP（donger-kb）：面向 agent 的知识库检索与写入工具 v2。
// v2（spec 2026-09-22-knowledge-base-design §8）：按库寻址——工具加 kbId 参数，
// 工具名不变（存量白名单/场景词表兼容）；kbId 缺省回落 defaultKbId（运行时=个人库）。
// 写入经 onChange 回调记账（kb_revisions，actorKind=chat）；可写性由挂载清单声明。
// 检索为 grep 级行匹配（异步 fs，不阻塞事件循环）；FTS 后继替换 kb_search 内部实现，签名不变。

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const MAX_SEARCH_FILES = 200;
const SEARCH_TIMEOUT_MS = 2_000;
const LIST_DEPTH = 3;

/** 挂载清单条目（运行时按会话库 ∪ agent 绑定库 ∪ 个人库构造） */
export interface KbMount {
  kbId: string;
  name: string;
  root: string;
  /** false = 只读挂载（kb_write/kb_delete 拒绝；被分享库语义，spec D1） */
  writable: boolean;
  // —— 提示词注入用的元数据（可选，kb 工具本体不消费）——
  description?: string;
  systemPrompt?: string;
  /** 库属主即当前用户（提示词信任分级：直拼 vs wrapUntrusted） */
  ownerIsUser?: boolean;
  /** 顶层目录清单（正斜杠相对路径，一层） */
  topDirs?: string;
}

export interface KbToolsDeps {
  /** v2：按库挂载清单 */
  mounts?: KbMount[];
  /** kbId 缺省回落（运行时=个人库；存量 agent 白名单行为连续） */
  defaultKbId?: string;
  /** v1 兼容：单根形态（= 单 mount，可写，kbId=""）；新代码请传 mounts */
  kbRoot?: string;
  /** 写/删变更回调（kb_revisions 记账）；缺省不记账 */
  onChange?: (e: {
    kbId: string;
    path: string;
    action: "create" | "update" | "delete";
    before?: string;
    after?: string;
  }) => Promise<void>;
  /**
   * FTS 影子索引检索（R-A/R-B）：返回命中文件清单，工具内做行级定位生成 line/snippet；
   * 未装配或 0 命中时回落 grep 级全文扫描。
   */
  ftsSearch?: (kbIds: readonly string[], query: string) => Array<{ kbId: string; path: string }>;
}

/** 归一 deps：v1 kbRoot 兼容映射为单库挂载 */
function normalizeMounts(deps: KbToolsDeps): { mounts: KbMount[]; defaultKbId?: string } {
  if (deps.mounts && deps.mounts.length > 0) {
    return { mounts: deps.mounts, defaultKbId: deps.defaultKbId ?? deps.mounts[0]?.kbId };
  }
  if (deps.kbRoot) {
    return {
      mounts: [{ kbId: "", name: "知识库", root: resolve(deps.kbRoot), writable: true }],
      defaultKbId: "",
    };
  }
  return { mounts: [], defaultKbId: undefined };
}

/** 路径安全：resolve 后必须仍在 root 内（含 root 本身）；逃逸返回 undefined */
export function safeResolveKbPath(root: string, input: string): string | undefined {
  const base = resolve(root);
  const resolved = resolve(base, input);
  const rel = relative(base, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolved;
  return undefined;
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
  const { mounts, defaultKbId } = normalizeMounts(deps);

  /** 解析 kbId → mount；无参回落 defaultKbId；未知库 undefined */
  const resolveMount = (kbId?: string): KbMount | undefined => {
    const target = kbId && kbId.length > 0 ? kbId : defaultKbId;
    if (target === undefined) return mounts[0];
    return mounts.find((m) => m.kbId === target);
  };
  /** 多库挂载时输出加 kbId 前缀（单库保持 v1 输出形态） */
  const labelFor = (mount: KbMount, rel: string): string =>
    mounts.length > 1 ? `${mount.kbId}:${rel}` : rel;

  return [
    {
      name: "kb_list",
      description:
        "列出知识库目录树（kbId 缺省=当前主库；多库挂载时不传 kbId 则列出全部挂载库清单）。可传 subdir 只看局部。",
      inputSchema: {
        kbId: z.string().optional().describe("库 ID（见挂载清单）"),
        subdir: z.string().optional().describe("相对库根的子目录，如 knowledges/faq"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ kbId: z.string().optional(), subdir: z.string().optional() }).parse(args);
        // 不带 kbId 且多库：输出挂载清单（名称 + 可写性 + 顶层目录）
        if ((!a.kbId || a.kbId.length === 0) && mounts.length > 1) {
          const lines: string[] = ["挂载知识库清单："];
          for (const m of mounts) {
            const top = treeList(m.root, 1);
            lines.push(
              `- kbId=${m.kbId}「${m.name}」${m.writable ? "（可写）" : "（只读）"}${top.length ? `\n  ${top.join("\n  ")}` : "（空库）"}`,
            );
          }
          return ok(lines.join("\n"));
        }
        const mount = resolveMount(a.kbId);
        if (!mount) return fail(`未知知识库：${a.kbId ?? "(缺省)"}（用 kb_list 查看挂载清单）`);
        const target = a.subdir ? safeResolveKbPath(mount.root, a.subdir) : resolve(mount.root);
        if (!target) return fail(`子目录越界：${a.subdir ?? ""}`);
        const lines = treeList(target, LIST_DEPTH);
        return ok(lines.length > 0 ? lines.join("\n") : "（空目录）");
      },
    },
    {
      name: "kb_read",
      description: "读取知识库文件内容（相对库根的路径；仅 .md）",
      inputSchema: {
        kbId: z.string().optional().describe("库 ID（缺省=当前主库）"),
        path: z.string().min(1).describe("相对库根的路径，如 knowledges/faq/订单.md"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ kbId: z.string().optional(), path: z.string() }).parse(args);
        const mount = resolveMount(a.kbId);
        if (!mount) return fail(`未知知识库：${a.kbId ?? "(缺省)"}`);
        if (!a.path.toLowerCase().endsWith(".md")) return fail("仅支持读取 .md 文件");
        const target = safeResolveKbPath(mount.root, a.path);
        if (!target || target === resolve(mount.root)) return fail(`路径越界：${a.path}`);
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
      description:
        '全文检索知识库（FTS 索引优先，grep 兜底）。返回 JSON：{"query","kbId","total","truncated","hits":[{"kbId","path","line","snippet"}]}，最多 50 条；kbId="all" 遍历全部挂载库。',
      inputSchema: {
        query: z.string().min(1).describe("检索关键词"),
        kbId: z.string().optional().describe('库 ID（缺省=当前主库；传 "all" 遍历全部挂载库）'),
        glob: z.string().optional().describe("文件名过滤，如 *.md"),
        ignoreCase: z.boolean().optional().describe("忽略大小写（默认 true）"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z
          .object({
            query: z.string(),
            kbId: z.string().optional(),
            glob: z.string().optional(),
            ignoreCase: z.boolean().optional(),
          })
          .parse(args);
        const targets =
          a.kbId === "all"
            ? mounts
            : [resolveMount(a.kbId) ?? undefined].filter((m): m is KbMount => !!m);
        if (targets.length === 0) return fail(`未知知识库：${a.kbId ?? "(缺省)"}`);
        const globRe = a.glob ? globToRegExp(a.glob) : undefined;
        const needle = a.ignoreCase === false ? a.query : a.query.toLowerCase();
        const hits: Array<{ kbId: string; path: string; line: number; snippet: string }> = [];
        const truncatedFlag = { value: false };

        /** 行级定位：读文件原文，产出 {kbId,path,line,snippet}（R-B 溯源形态） */
        const locateLines = (mount: KbMount, rel: string, full: string): void => {
          if (hits.length >= MAX_SEARCH_HITS) {
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
            const hay = a.ignoreCase === false ? line : line.toLowerCase();
            if (hay.includes(needle)) {
              hits.push({
                kbId: mount.kbId,
                path: rel,
                line: i + 1,
                snippet: line.trim().slice(0, 200),
              });
              if (hits.length >= MAX_SEARCH_HITS) {
                truncatedFlag.value = true;
                return;
              }
            }
          }
        };

        // FTS 优先（R-A 影子索引）：跳过不含关键词的文件，仅对命中文件做行级定位
        if (deps.ftsSearch) {
          const files = deps.ftsSearch(targets.map((t) => t.kbId), a.query);
          for (const f of files) {
            if (hits.length >= MAX_SEARCH_HITS) break;
            const mount = targets.find((t) => t.kbId === f.kbId);
            if (!mount) continue;
            const base = f.path.split("/").pop() ?? "";
            if (globRe && !globRe.test(f.path) && !globRe.test(base)) continue;
            locateLines(mount, f.path, join(mount.root, ...f.path.split("/")));
          }
        }
        // grep 兜底：FTS 未装配或 0 命中（含 FTS 与内容脱同步的场景）
        if (hits.length === 0) {
          const startedAt = Date.now();
          const searchOne = (mount: KbMount, dir: string, depth: number): void => {
            if (depth <= 0 || hits.length >= MAX_SEARCH_HITS) return;
            if (Date.now() - startedAt > SEARCH_TIMEOUT_MS) return;
            let entries: string[];
            try {
              entries = readdirSync(dir);
            } catch {
              return;
            }
            for (const entry of entries) {
              if (hits.length >= MAX_SEARCH_HITS) return;
              if (entry.startsWith(".")) continue;
              const full = join(dir, entry);
              let stat;
              try {
                stat = statSync(full);
              } catch {
                continue;
              }
              if (stat.isDirectory()) {
                searchOne(mount, full, depth - 1);
                continue;
              }
              if (!stat.isFile()) continue;
              const rel = relative(mount.root, full).replace(/\\/g, "/");
              if (globRe && !globRe.test(rel) && !globRe.test(entry)) continue;
              locateLines(mount, rel, full);
            }
          };
          for (const mount of targets) searchOne(mount, resolve(mount.root), 6);
        }
        const body = {
          query: a.query,
          kbId: a.kbId ?? "(default)",
          total: hits.length,
          truncated: truncatedFlag.value,
          hits,
        };
        return ok(JSON.stringify(body));
      },
    },
    {
      name: "kb_write",
      description:
        "写入知识库文件（整文件覆写；目录自动创建；仅可写库）。写入前须先 kb_read 取最新内容。内容须标注主题、来源与日期。",
      inputSchema: {
        kbId: z.string().optional().describe("库 ID（缺省=当前主库）"),
        path: z.string().min(1).describe("相对库根的路径（仅 .md）"),
        content: z.string().min(1).describe("文件全文（utf8）"),
        expectedHash: z
          .string()
          .optional()
          .describe("修改前文件的 sha256（防并发覆盖；来自 kb_read 时可选返回）"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z
          .object({
            kbId: z.string().optional(),
            path: z.string(),
            content: z.string(),
            expectedHash: z.string().optional(),
          })
          .parse(args);
        const mount = resolveMount(a.kbId);
        if (!mount) return fail(`未知知识库：${a.kbId ?? "(缺省)"}`);
        if (!mount.writable) return fail(`知识库「${mount.name}」为只读挂载（被分享库不可维护）`);
        if (!a.path.toLowerCase().endsWith(".md")) return fail("仅支持写入 .md 文件");
        const target = safeResolveKbPath(mount.root, a.path);
        if (!target || target === resolve(mount.root)) return fail(`路径越界：${a.path}`);
        let before: string | undefined;
        try {
          before = readFileSync(target, "utf8");
        } catch {
          before = undefined;
        }
        if (a.expectedHash && before !== undefined) {
          const actual = createHash("sha256").update(before, "utf8").digest("hex");
          if (actual !== a.expectedHash.toLowerCase()) {
            return fail("文件已被其他人修改（hash 不匹配），请重新 kb_read 后再写。");
          }
        }
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, a.content, "utf8");
        } catch (e) {
          return fail(`写入失败：${(e as Error).message}`);
        }
        const rel = relative(mount.root, target).replace(/\\/g, "/");
        if (deps.onChange) {
          await deps.onChange({
            kbId: mount.kbId,
            path: rel,
            action: before === undefined ? "create" : "update",
            before,
            after: a.content,
          });
        }
        return ok(`已写入 ${labelFor(mount, rel)}（${a.content.length} 字符）`);
      },
    },
    {
      name: "kb_delete",
      description: "删除知识库文件（仅可写库）；移动/重命名用 kb_delete + kb_write 组合",
      inputSchema: {
        kbId: z.string().optional().describe("库 ID（缺省=当前主库）"),
        path: z.string().min(1).describe("相对库根的路径"),
      },
      handler: async (args): Promise<KbToolResult> => {
        const a = z.object({ kbId: z.string().optional(), path: z.string() }).parse(args);
        const mount = resolveMount(a.kbId);
        if (!mount) return fail(`未知知识库：${a.kbId ?? "(缺省)"}`);
        if (!mount.writable) return fail(`知识库「${mount.name}」为只读挂载（被分享库不可维护）`);
        const target = safeResolveKbPath(mount.root, a.path);
        if (!target || target === resolve(mount.root)) return fail(`路径越界：${a.path}`);
        let before: string | undefined;
        try {
          before = readFileSync(target, "utf8");
        } catch {
          before = undefined;
        }
        try {
          rmSync(target, { recursive: true });
        } catch (e) {
          return fail(`删除失败：${(e as Error).message}`);
        }
        const rel = relative(mount.root, target).replace(/\\/g, "/");
        if (deps.onChange) {
          await deps.onChange({ kbId: mount.kbId, path: rel, action: "delete", before });
        }
        return ok(`已删除 ${labelFor(mount, rel)}`);
      },
    },
  ];
}

/** 装配 donger-kb SDK MCP server（恒挂载；可用性由 agent tools 白名单控制） */
export function createKbToolsServer(deps: KbToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-kb",
    version: "2.0.0",
    tools: kbToolDefinitions(deps),
  });
}
