import type { AgentExtensionDirectory } from "../domain/extension-directory.js";

export interface ResolvedExtensionDirectory extends AgentExtensionDirectory {
  path: string;
}

export interface ExtensionDirectoryResolution {
  available: ResolvedExtensionDirectory[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
}

export interface ExtensionDirectoryResolver {
  /**
   * 解析扩展目录条目 → 可用绝对路径。anchor 为该用户的绝对工作区根（user.homeDir）：
   * 仅相对路径可用（存量绝对条目降级 unavailable），realpath 后必须仍在 anchor 内
   * （specs/2026-09-21-extension-dir-relative-path-design.md §2.3）。
   */
  resolve(items: AgentExtensionDirectory[], anchor: string): Promise<ExtensionDirectoryResolution>;
}
