/**
 * 活动行格式化（chat UE 轮 E2-A v2）：SSE activity 摘要行 → 结构化视图。
 * 来源三态：编排器工具摘要行（mcp__x__y {args} / Bash {args}）、失败行（⚠️ 前缀/「失败」字样）、
 * 阶段横幅等纯文本（🔨 执行阶段）。纯函数，ActivityStrip 消费。
 */

export interface ActivityLineView {
  kind: "error" | "tool" | "text";
  /** 主文案：工具显示名 / 失败摘要 / 原文 */
  label: string;
  /** 参数摘要（工具行才有；键值优先级同工具卡 inputSummary） */
  detail: string;
}

const MCP_TOOL_RE = /mcp__([\w.-]+)__\s*([\w.-]+)/;
const BUILTIN_TOOL_RE =
  /\b(Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Task|WebFetch|WebSearch|TodoWrite)\b/;

const ARGS_KEY_PRIORITY = [
  "command",
  "file_path",
  "query",
  "pattern",
  "url",
  "path",
  "repoName",
  "name",
  "strategy",
] as const;

/** 参数摘要：JSON 取优先键值，截 80 字符；解析失败原文截断（与工具卡 inputSummary 同口径） */
function argsSummary(argsText: string): string {
  const trimmed = argsText.trim();
  if (!trimmed || trimmed === "{}") return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ARGS_KEY_PRIORITY) {
      const value = parsed[key];
      if (typeof value === "string" && value) {
        return value.replace(/\s+/g, " ").slice(0, 80);
      }
    }
    // 无优先键：取首个字符串值
    for (const value of Object.values(parsed)) {
      if (typeof value === "string" && value) {
        return value.replace(/\s+/g, " ").slice(0, 80);
      }
    }
    return "";
  } catch {
    return trimmed.replace(/\s+/g, " ").slice(0, 80);
  }
}

export function formatActivityLine(raw: string): ActivityLineView {
  const text = raw.replace(/^[🔧🔨]\s*/u, "").trim();
  if (!text) return { kind: "text", label: "", detail: "" };
  if (/^⚠️|失败|出错/.test(text)) {
    // 失败行：⚠️ 去噪 + mcp 工具名就地换显示名，保留人读摘要
    const label = text
      .replace(/^⚠️\s*/, "")
      .replace(MCP_TOOL_RE, (_m, server: string, name: string) => `${server} · ${name}`);
    return { kind: "error", label, detail: "" };
  }
  const mcp = MCP_TOOL_RE.exec(text);
  if (mcp) {
    const rest = text.slice((mcp.index ?? 0) + mcp[0].length);
    return {
      kind: "tool",
      label: `${mcp[1]} · ${mcp[2]}`,
      detail: argsSummary(rest || "{}"),
    };
  }
  const builtin = BUILTIN_TOOL_RE.exec(text);
  if (builtin?.[1]) {
    const rest = text.slice((builtin.index ?? 0) + builtin[0].length);
    return { kind: "tool", label: builtin[1], detail: argsSummary(rest) };
  }
  return { kind: "text", label: text, detail: "" };
}
