// 文件浏览端口：多通道（Web/钉钉/…）共享的文件访问契约。
export type FileScope = "user" | "runtime" | "extension";

export interface FileNode {
  name: string;
  /** 相对 scope 根的路径，前端回传给 readFile/contentUrl，唯一标识 */
  path: string;
  isDir: boolean;
  /** 文件字节 */
  size?: number;
  children?: FileNode[];
}

export interface FileContent {
  buffer: Buffer;
  mime: string;
  size: number;
}

export interface ReadFileOptions {
  /** 超过字节数抛 PayloadTooLargeError；缺省不限 */
  maxBytes?: number;
}

export interface FileBrowser {
  listTree(userId: string, scope: FileScope, conversationId?: string): Promise<FileNode[]>;
  readFile(
    userId: string,
    scope: FileScope,
    relPath: string,
    conversationId?: string,
    opts?: ReadFileOptions,
  ): Promise<FileContent>;
  /**
   * 解析 scope 相对路径为绝对路径（属主/边界/symlink 校验与 readFile 同一链路）。
   * 供消息 @引用 在发送前把前端路径换算为可信绝对路径；不存在/越界抛错。
   */
  resolveFilePath(
    userId: string,
    scope: FileScope,
    relPath: string,
    conversationId?: string,
  ): Promise<string>;
}
