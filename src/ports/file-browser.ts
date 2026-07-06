// 文件浏览端口：多通道（Web/钉钉/…）共享的文件访问契约。
export type FileScope = "user" | "runtime";

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
}
