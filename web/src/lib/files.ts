export type FileScope = "user" | "runtime" | "extension";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children?: FileNode[];
}

export async function fetchTree(args: {
  scope: FileScope;
  conversationId?: string;
  token: string;
}): Promise<FileNode[]> {
  const qs = new URLSearchParams({ scope: args.scope, token: args.token });
  if (args.conversationId) qs.set("conversationId", args.conversationId);
  const res = await fetch(`/api/files/tree?${qs.toString()}`);
  if (!res.ok) throw new Error(`加载文件树失败: ${res.status}`);
  const body = (await res.json()) as { nodes: FileNode[] };
  return body.nodes;
}

export function contentUrl(args: {
  scope: FileScope;
  path: string;
  conversationId?: string;
  token: string;
  download?: boolean;
}): string {
  const qs = new URLSearchParams({ scope: args.scope, path: args.path, token: args.token });
  if (args.conversationId) qs.set("conversationId", args.conversationId);
  if (args.download) qs.set("download", "1");
  return `/api/files/content?${qs.toString()}`;
}
