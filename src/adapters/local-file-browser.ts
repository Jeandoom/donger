// 本地 fs 的 FileBrowser 实现。多通道共享。
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { IGNORED_NAMES, resolveWithinRoots, scopeRoots } from "../domain/file-browser.js";
import { mimeForExt } from "../domain/file-mime.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { ExtensionDirectoryResolver } from "../ports/extension-directory-resolver.js";
import type {
  FileBrowser,
  FileContent,
  FileNode,
  FileScope,
  ReadFileOptions,
} from "../ports/file-browser.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError, PayloadTooLargeError } from "../util/errors.js";

export interface LocalFileBrowserDeps {
  userStore: UserStore;
  conversationStore: ConversationStore;
  workspaceDir: string;
  agentStore?: AgentStore;
  extensionDirectoryResolver?: ExtensionDirectoryResolver;
}

export class LocalFileBrowser implements FileBrowser {
  constructor(private readonly deps: LocalFileBrowserDeps) {}

  async listTree(userId: string, scope: FileScope, conversationId?: string): Promise<FileNode[]> {
    const { roots, labels } = await this.resolveRoots(userId, scope, conversationId);
    if (scope === "runtime") {
      // 拍平展示：直接返回会话工作区内容，不再包一层会话目录节点
      return this.buildDirNode(roots[0] ?? "", "", "").children ?? [];
    }
    return roots.map((root, i) => this.buildDirNode(root, labels[i] ?? basename(root), ""));
  }

  async readFile(
    userId: string,
    scope: FileScope,
    relPath: string,
    conversationId?: string,
    opts?: ReadFileOptions,
  ): Promise<FileContent> {
    const abs = await this.resolveFilePath(userId, scope, relPath, conversationId);

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundError("NOT_FOUND", "文件不存在");
    }
    if (st.isDirectory()) throw new NotFoundError("NOT_FOUND", "目标是目录");
    if (opts?.maxBytes !== undefined && st.size > opts.maxBytes) {
      throw new PayloadTooLargeError("TOO_LARGE", `文件超过 ${opts.maxBytes} 字节`);
    }
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    return {
      buffer: readFileSync(abs),
      mime: mimeForExt(ext),
      size: st.size,
    };
  }

  async resolveFilePath(
    userId: string,
    scope: FileScope,
    relPath: string,
    conversationId?: string,
  ): Promise<string> {
    const abs = await this.resolveAbsPath(userId, scope, relPath, conversationId);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new NotFoundError("NOT_FOUND", "文件不存在");
    }
    if (!st.isFile()) throw new NotFoundError("NOT_FOUND", "目标是目录");
    return abs;
  }

  /**
   * scope 相对路径 → 经边界与 symlink 校验的绝对路径（readFile/resolveFilePath 共用）。
   * runtime 树已拍平：relPath 直接相对唯一 runtime 根解析；其余 scope 的 path 形如
   * "<label>[/<rest>]"，第一段选择根，其余是根内相对路径。兼容 / 与 \。
   */
  private async resolveAbsPath(
    userId: string,
    scope: FileScope,
    relPath: string,
    conversationId?: string,
  ): Promise<string> {
    const { roots, labels } = await this.resolveRoots(userId, scope, conversationId);
    let root: string;
    let rest: string;
    if (scope === "runtime") {
      root = roots[0] ?? "";
      rest = relPath;
    } else {
      const m = relPath.match(/^([^/\\]+)[/\\](.*)$/);
      const head = m ? (m[1] ?? "") : relPath;
      rest = m ? (m[2] ?? "") : "";
      const idx = labels.indexOf(head);
      if (idx === -1) throw new ForbiddenError("FORBIDDEN", "路径越界");
      root = roots[idx] ?? "";
    }
    const resolved = resolveWithinRoots([root], rest);
    if (!resolved.ok) throw new ForbiddenError("FORBIDDEN", "路径越界");

    // realpath 后用 relativeOfRoot 复判，挡 symlink 指向根外
    let realAbs: string | null = null;
    try {
      realAbs = realpathSync(resolved.abs);
    } catch {
      throw new NotFoundError("NOT_FOUND", "文件不存在");
    }
    if (relativeOfRoot(roots, realAbs) === undefined) {
      throw new ForbiddenError("FORBIDDEN", "symlink 越界");
    }
    return realAbs;
  }

  private async resolveRoots(
    userId: string,
    scope: FileScope,
    conversationId?: string,
  ): Promise<{ roots: string[]; labels: string[] }> {
    if (scope === "extension") {
      if (!conversationId) throw new ForbiddenError("FORBIDDEN", "扩展目录需要 conversationId");
      const conversation = await this.deps.conversationStore.get(conversationId);
      if (!conversation || conversation.userId !== userId || !conversation.agentId) {
        throw new ForbiddenError("FORBIDDEN", "会话不存在或未绑定智能体");
      }
      const agent = await this.deps.agentStore?.get(conversation.agentId);
      if (!agent || agent.ownerId !== userId) {
        throw new ForbiddenError("FORBIDDEN", "共享智能体不开放创建者的扩展目录");
      }
      if (!this.deps.extensionDirectoryResolver) {
        throw new ForbiddenError("FORBIDDEN", "扩展目录解析器未装配");
      }
      const user = await this.deps.userStore.get(userId);
      if (!user) throw new ForbiddenError("FORBIDDEN", "用户不存在");
      const resolution = await this.deps.extensionDirectoryResolver.resolve(
        agent.extensionDirectories,
        resolve(user.homeDir),
      );
      return {
        roots: resolution.available.map((item) => item.path),
        labels: resolution.available.map((item) => item.name),
      };
    }
    if (scope === "runtime") {
      if (!conversationId) throw new ForbiddenError("FORBIDDEN", "runtime 需要 conversationId");
      const conv = await this.deps.conversationStore.get(conversationId);
      if (!conv || conv.userId !== userId) {
        throw new ForbiddenError("FORBIDDEN", "会话不属于当前用户");
      }
      const user = await this.deps.userStore.get(userId);
      if (!user) throw new ForbiddenError("FORBIDDEN", "用户不存在");
      // 历史用户行可能存了相对 homeDir；realpath 复判按绝对路径比对，这里统一归一
      // （与 RuntimeManager 按 cwd 解析的语义一致）。
      const homeDir = resolve(user.homeDir);
      const roots = scopeRoots("runtime", {
        homeDir,
        workspaceDir: this.deps.workspaceDir,
        conversationId,
        agentId: conv.agentId || undefined,
      });
      return { roots, labels: [conversationId] };
    }
    const user = await this.deps.userStore.get(userId);
    if (!user) throw new ForbiddenError("FORBIDDEN", "用户不存在");
    const roots = scopeRoots("user", {
      homeDir: resolve(user.homeDir),
      workspaceDir: this.deps.workspaceDir,
    });
    const labels = [".skills", ".agents", ".workflows", "knowledge_base"];
    return { roots, labels };
  }

  private buildDirNode(abs: string, name: string, parentRel: string): FileNode {
    return dirNode(abs, name, parentRel);
  }
}

/** 递归构建目录树节点；跳过忽略项与 symlink（防逃逸） */
function dirNode(abs: string, name: string, parentRel: string): FileNode {
  const path = parentRel ? posixJoin(parentRel, name) : name;
  let entries: string[] = [];
  try {
    entries = readdirSync(abs);
  } catch {
    return { name, path, isDir: true, children: [] };
  }
  const children: FileNode[] = [];
  for (const e of entries) {
    if (IGNORED_NAMES.has(e)) continue;
    const childAbs = join(abs, e);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(childAbs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // 跳过 symlink，防逃逸
    if (st.isDirectory()) {
      children.push(dirNode(childAbs, e, path));
    } else {
      children.push({ name: e, path: posixJoin(path, e), isDir: false, size: st.size });
    }
  }
  return { name, path, isDir: true, children };
}

/**
 * 拍平根目录下全部文件（相对路径；忽略项/symlink 规则与目录树一致）。
 * 供消息引用（mention）候选列表使用：给 @ 候选提供可搜索的扁平文件清单。
 */
export function flattenWorkspaceFiles(absRoot: string): FileNode[] {
  const out: FileNode[] = [];
  const visit = (node: FileNode): void => {
    for (const child of node.children ?? []) {
      if (child.isDir) visit(child);
      else out.push(child);
    }
  };
  visit(dirNode(absRoot, "", ""));
  return out;
}

/** posix 风格 join（输出 / 分隔的逻辑路径，供前端/URL 统一） */
function posixJoin(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}

/** 给定 roots 和绝对路径，返回相对某根的 rel（找不到返回 undefined） */
function relativeOfRoot(roots: string[], abs: string): string | undefined {
  for (const r of roots) {
    if (abs === r) return "";
    if (abs.startsWith(`${r}/`) || abs.startsWith(`${r}\\`)) return abs.slice(r.length + 1);
  }
  return undefined;
}
