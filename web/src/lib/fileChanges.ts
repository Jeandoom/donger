import { apiFetch } from "./auth";

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
