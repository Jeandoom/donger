import { realpathSync, statSync } from "node:fs";
import type { AgentExtensionDirectory } from "../domain/extension-directory.js";
import type {
  ExtensionDirectoryResolution,
  ExtensionDirectoryResolver,
} from "../ports/extension-directory-resolver.js";

export class LocalExtensionDirectoryResolver implements ExtensionDirectoryResolver {
  async resolve(items: AgentExtensionDirectory[]): Promise<ExtensionDirectoryResolution> {
    const available: ExtensionDirectoryResolution["available"] = [];
    const unavailable: ExtensionDirectoryResolution["unavailable"] = [];
    for (const item of items) {
      try {
        const path = realpathSync(item.path);
        if (!statSync(path).isDirectory()) throw new Error("目标不是目录");
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
