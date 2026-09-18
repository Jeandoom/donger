import type { AgentExtensionDirectory } from "../domain/extension-directory.js";

export interface ResolvedExtensionDirectory extends AgentExtensionDirectory {
  path: string;
}

export interface ExtensionDirectoryResolution {
  available: ResolvedExtensionDirectory[];
  unavailable: Array<{ id: string; name: string; reason: string }>;
}

export interface ExtensionDirectoryResolver {
  resolve(items: AgentExtensionDirectory[]): Promise<ExtensionDirectoryResolution>;
}
