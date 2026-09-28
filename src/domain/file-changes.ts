import { join, relative, sep } from "node:path";
import type { AuditEvent } from "./types.js";

/**
 * 对话文件变更（spec 2026-09-24-mcp-auth-files-design §4）：
 * 数据源 = audit_events 的写入类 tool_use 行（Write/Edit/MultiEdit/NotebookEdit）。
 * Edit 的 old_string/new_string、Write 的 content 可逐行还原 diff；
 * 审计侧 toolInput 落库时截断 4096 字符，parse 失败的行标记 truncated（当前内容
 * 由「结果」视图经 fileBrowser 读活文件兜底）。Bash 重定向等旁路写盘不在还原范围。
 */

export const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface DiffRow {
  type: "add" | "del" | "ctx";
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface FileChangeSegment {
  at: string;
  tool: string;
  kind: "write" | "edit";
  taskId: string | null;
  /** true = 审计入参被截断，diff 不可还原 */
  truncated: boolean;
  rows: DiffRow[];
  adds: number;
  removes: number;
}

export interface FileChangeSummary {
  /** 服务端绝对路径（列表→详情/内容回传的键） */
  path: string;
  /** 剥离工作区前缀后的展示路径 */
  displayPath: string;
  language: string;
  firstOp: "created" | "modified";
  lastChangedAt: string;
  writes: number;
  edits: number;
  adds: number;
  removes: number;
  truncated: boolean;
}

const DIFF_LINE_CAP = 1500;

/**
 * 行级 LCS diff（前后缀裁剪 + 中段 DP）。中段任一侧超过 1500 行时退化为
 * 「全删 + 全增」并标 truncated，避免 O(n·m) 内存失控。
 */
export function diffRows(
  oldText: string,
  newText: string,
): { rows: DiffRow[]; truncated: boolean } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) {
    pre++;
  }
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++;
  }

  const oldMid = oldLines.slice(pre, oldLines.length - suf);
  const newMid = newLines.slice(pre, newLines.length - suf);
  const rows: DiffRow[] = [];
  for (let i = 0; i < pre; i++) {
    rows.push({ type: "ctx", oldNo: i + 1, newNo: i + 1, text: oldLines[i] ?? "" });
  }

  let truncated = false;
  if (oldMid.length === 0 && newMid.length === 0) {
    // 内容相同（如重复 Write）
  } else if (oldMid.length > DIFF_LINE_CAP || newMid.length > DIFF_LINE_CAP) {
    truncated = true;
    oldMid.forEach((text, i) => {
      rows.push({ type: "del", oldNo: pre + i + 1, text });
    });
    newMid.forEach((text, i) => {
      rows.push({ type: "add", newNo: pre + i + 1, text });
    });
  } else {
    // 中段 LCS（Int32Array 一维 DP）
    const n = oldMid.length;
    const m = newMid.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          oldMid[i] === newMid[j]
            ? (dp[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * (m + 1) + j] ?? 0, dp[i * (m + 1) + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldMid[i] === newMid[j]) {
        rows.push({ type: "ctx", oldNo: pre + i + 1, newNo: pre + j + 1, text: oldMid[i] ?? "" });
        i++;
        j++;
      } else if ((dp[(i + 1) * (m + 1) + j] ?? 0) >= (dp[i * (m + 1) + j + 1] ?? 0)) {
        rows.push({ type: "del", oldNo: pre + i + 1, text: oldMid[i] ?? "" });
        i++;
      } else {
        rows.push({ type: "add", newNo: pre + j + 1, text: newMid[j] ?? "" });
        j++;
      }
    }
    while (i < n) {
      rows.push({ type: "del", oldNo: pre + i + 1, text: oldMid[i] ?? "" });
      i++;
    }
    while (j < m) {
      rows.push({ type: "add", newNo: pre + j + 1, text: newMid[j] ?? "" });
      j++;
    }
  }

  for (let k = 0; k < suf; k++) {
    const oldNo = oldLines.length - suf + k + 1;
    const newNo = newLines.length - suf + k + 1;
    rows.push({ type: "ctx", oldNo, newNo, text: oldLines[oldLines.length - suf + k] ?? "" });
  }
  return { rows, truncated };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  // 尾随换行产生的空尾行不作为一行展示
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  txt: "text",
  yaml: "yaml",
  yml: "yaml",
  html: "markup",
  htm: "markup",
  css: "css",
  scss: "scss",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  toml: "toml",
  ini: "ini",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  csv: "text",
  ipynb: "json",
};

export function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return LANGUAGE_BY_EXT[ext] ?? "text";
}

/** 剥离显示前缀：roots 按最长匹配优先（调用方把更具体的 workspace 根排前面） */
export function displayPathOf(absPath: string, roots: string[]): string {
  const normalized = absPath.split(sep).join("/");
  let best = normalized;
  for (const root of roots) {
    const rootNorm = root.split(sep).join("/").replace(/\/+$/, "");
    if (normalized === rootNorm) return ".";
    const withSlash = `${rootNorm}/`;
    if (normalized.startsWith(withSlash)) {
      const rel = normalized.slice(withSlash.length);
      if (rel.length < best.length) best = rel;
    }
  }
  return best;
}

interface ParsedToolInput {
  filePath?: string;
  kind: "write" | "edit";
  oldText?: string;
  newText?: string;
  /** MultiEdit 展开为多条 */
  edits?: Array<{ oldText: string; newText: string }>;
}

function parseToolInput(toolName: string, raw: string): ParsedToolInput | undefined {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (toolName === "Write") {
    return { filePath: str(input.file_path), kind: "write", newText: str(input.content) };
  }
  if (toolName === "Edit") {
    return {
      filePath: str(input.file_path),
      kind: "edit",
      oldText: str(input.old_string),
      newText: str(input.new_string),
    };
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return {
      filePath: str(input.file_path),
      kind: "edit",
      edits: edits
        .map((e) => e as Record<string, unknown>)
        .map((e) => ({ oldText: str(e.old_string), newText: str(e.new_string) })),
    };
  }
  if (toolName === "NotebookEdit") {
    return { filePath: str(input.notebook_path), kind: "write", newText: str(input.new_source) };
  }
  return undefined;
}

/** 截断的 toolInput 里抢救 file_path（前缀字段通常仍完整） */
function salvageFilePath(raw: string): string | undefined {
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

export function parseFileChanges(
  events: AuditEvent[],
  opts: { displayRoots: string[] },
): { files: FileChangeSummary[]; segmentsByPath: Map<string, FileChangeSegment[]> } {
  const segmentsByPath = new Map<string, FileChangeSegment[]>();

  for (const event of events) {
    if (event.type !== "tool_use" || !event.toolName || !FILE_CHANGE_TOOLS.has(event.toolName)) {
      continue;
    }
    const raw = event.toolInput ?? "";
    const parsed = parseToolInput(event.toolName, raw);
    const at = event.recordedAt;
    const taskId = event.taskId || null;
    const segments: FileChangeSegment[] = [];

    if (!parsed) {
      segments.push({
        at,
        tool: event.toolName,
        kind: "edit",
        taskId,
        truncated: true,
        rows: [],
        adds: 0,
        removes: 0,
      });
      const path = salvageFilePath(raw) ?? "(无法解析的写入)";
      pushSegments(segmentsByPath, path, segments);
      continue;
    }

    if (parsed.edits) {
      for (const edit of parsed.edits) {
        const { rows } = diffRows(edit.oldText, edit.newText);
        segments.push(segment(event.toolName, "edit", at, taskId, rows, false));
      }
    } else if (parsed.kind === "write") {
      const { rows } = diffRows("", parsed.newText ?? "");
      segments.push(segment(event.toolName, "write", at, taskId, rows, false));
    } else {
      const { rows } = diffRows(parsed.oldText ?? "", parsed.newText ?? "");
      segments.push(segment(event.toolName, "edit", at, taskId, rows, false));
    }
    pushSegments(segmentsByPath, parsed.filePath ?? "(未知路径)", segments);
  }

  const files: FileChangeSummary[] = [];
  for (const [path, segs] of segmentsByPath) {
    const lastChangedAt = segs.reduce((acc, s) => (s.at > acc ? s.at : acc), segs[0]?.at ?? "");
    const firstIsWrite = segs[0]?.kind === "write";
    const adds = segs.reduce((acc, s) => acc + s.adds, 0);
    const removes = segs.reduce((acc, s) => acc + s.removes, 0);
    files.push({
      path,
      displayPath: displayPathOf(path, opts.displayRoots),
      language: languageOf(path),
      firstOp: firstIsWrite ? "created" : "modified",
      lastChangedAt,
      writes: segs.filter((s) => s.kind === "write").length,
      edits: segs.filter((s) => s.kind === "edit").length,
      adds,
      removes,
      truncated: segs.some((s) => s.truncated),
    });
  }
  files.sort((a, b) => (a.lastChangedAt < b.lastChangedAt ? 1 : -1));
  return { files, segmentsByPath };
}

function segment(
  tool: string,
  kind: "write" | "edit",
  at: string,
  taskId: string | null,
  rows: DiffRow[],
  truncated: boolean,
): FileChangeSegment {
  return {
    at,
    tool,
    kind,
    taskId,
    truncated,
    rows,
    adds: rows.filter((r) => r.type === "add").length,
    removes: rows.filter((r) => r.type === "del").length,
  };
}

function pushSegments(
  map: Map<string, FileChangeSegment[]>,
  path: string,
  segments: FileChangeSegment[],
): void {
  const existing = map.get(path) ?? [];
  existing.push(...segments);
  map.set(path, existing);
}

/** 会话绑定的工作区根（与 runtime-manager 推导同式），供 displayPath 与当前内容读取 */
export function conversationWorkspaceRoots(
  homeDir: string,
  conversation: { id: string; agentId: string | null },
): string[] {
  return conversation.agentId
    ? [join(homeDir, "agents", conversation.agentId, "workspace"), homeDir]
    : [join(homeDir, "sessions", conversation.id, "workspace"), homeDir];
}

/** 相对化当前内容读取路径：abs 必须在 root 之下，否则 undefined（工作区外不可读） */
export function relativeUnderRoot(absPath: string, root: string): string | undefined {
  const rel = relative(root, absPath);
  if (!rel || rel.startsWith("..") || rel.split(sep)[0] === "..") return undefined;
  return rel.split(sep).join("/");
}
