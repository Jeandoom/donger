import { apiFetch } from "./auth";

/** 触发文件变更记录的写入类工具（与 src/domain/file-changes.ts 的 FILE_CHANGE_TOOLS 对齐） */
export const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * tool_use 入参里取写入目标路径（Write/Edit/MultiEdit=file_path；NotebookEdit=notebook_path）。
 * 入参 JSON 可能被截断（SSE 500 字 / 审计 4096 字），截断时按前缀字段抢救（镜像后端 salvageFilePath）。
 */
export function toolChangePath(tool: string, inputPreview: string): string | null {
  if (!FILE_CHANGE_TOOLS.has(tool)) return null;
  try {
    const parsed = JSON.parse(inputPreview) as Record<string, unknown>;
    const p = parsed.file_path ?? parsed.notebook_path;
    if (typeof p === "string" && p) return p;
  } catch {
    // 截断/非 JSON → 抢救
  }
  const m = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inputPreview);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/** 提取去重后的变更文件路径（保持出现顺序） */
export function extractChangedFilePaths(
  items: ReadonlyArray<{ tool: string; inputPreview: string }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const p = toolChangePath(item.tool, item.inputPreview);
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** 链接展示用短路径：workspace 内取相对段（保留层级），否则取文件名（完整路径进 title） */
export function shortChangePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = normalized.lastIndexOf("/workspace/");
  if (marker >= 0) return normalized.slice(marker + "/workspace/".length);
  return normalized.split("/").at(-1) ?? normalized;
}

/** 会话文件变更（audit 写入类 tool_use 还原；行号为段内相对行号） */
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
  truncated: boolean;
  rows: DiffRow[];
  adds: number;
  removes: number;
}

export interface FileChangeSummary {
  path: string;
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

export interface FileChangeDetail {
  path: string;
  displayPath: string;
  language: string;
  segments: FileChangeSegment[];
}

export async function fetchFileChanges(conversationId: string): Promise<FileChangeSummary[]> {
  const res = await apiFetch(`/api/conversations/${conversationId}/file-changes`);
  if (!res.ok) throw new Error(`加载文件变更失败：HTTP ${res.status}`);
  const body = (await res.json()) as { files: FileChangeSummary[] };
  return body.files;
}

export async function fetchFileChangeDetail(
  conversationId: string,
  path: string,
): Promise<FileChangeDetail> {
  const qs = new URLSearchParams({ path });
  const res = await apiFetch(
    `/api/conversations/${conversationId}/file-changes/detail?${qs.toString()}`,
  );
  if (!res.ok) throw new Error(`加载变更详情失败：HTTP ${res.status}`);
  return (await res.json()) as FileChangeDetail;
}

export interface FileChangeContent {
  path: string;
  mime: string;
  content: string;
}

export async function fetchFileChangeContent(
  conversationId: string,
  path: string,
): Promise<FileChangeContent> {
  const qs = new URLSearchParams({ path });
  const res = await apiFetch(
    `/api/conversations/${conversationId}/file-changes/content?${qs.toString()}`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `读取当前内容失败：HTTP ${res.status}`);
  }
  return (await res.json()) as FileChangeContent;
}
