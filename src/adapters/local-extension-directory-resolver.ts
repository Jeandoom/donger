import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentExtensionDirectory } from "../domain/extension-directory.js";
import type {
  ExtensionDirectoryResolution,
  ExtensionDirectoryResolver,
} from "../ports/extension-directory-resolver.js";

/**
 * 本地 fs 的扩展目录解析：相对路径锚定用户工作区根。
 * 防线三层：绝对路径存量条目直接降级；realpath（存在性）；realpath 后仍在 anchor 内
 * 复判（挡 workspace 内 junction/symlink 指向锚点外，与 file-browser 复判标准一致）。
 */
export class LocalExtensionDirectoryResolver implements ExtensionDirectoryResolver {
  async resolve(
    items: AgentExtensionDirectory[],
    anchor: string,
  ): Promise<ExtensionDirectoryResolution> {
    const available: ExtensionDirectoryResolution["available"] = [];
    const unavailable: ExtensionDirectoryResolution["unavailable"] = [];
    let realAnchor: string | null = null;
    try {
      realAnchor = realpathSync(resolve(anchor));
    } catch {
      // 锚点缺失时所有条目降级（工作区根都不可用属异常态，理由逐条可见）
    }
    for (const item of items) {
      try {
        if (isAbsolute(item.path)) {
          throw new Error("仅支持相对路径（相对你的工作区根目录），请在智能体编辑页改写为相对路径");
        }
        if (!realAnchor) throw new Error("工作区根目录不可用");
        const path = realpathSync(resolve(realAnchor, item.path));
        if (!statSync(path).isDirectory()) throw new Error("目标不是目录");
        const rel = relative(realAnchor, path);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error("越界：目录经 symlink/junction 指向工作区外");
        }
        available.push({ ...item, path });
      } catch (error) {
        unavailable.push({
          id: item.id,
          name: item.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { available, unavailable };
  }
}
