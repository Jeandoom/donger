import type { AppManifest, AppVersionMeta, PlatformApp } from "../domain/app.js";

/** 应用数据条目（KV） */
export interface AppDataEntry {
  appId: string;
  key: string;
  /** JSON 序列化后的字符串 */
  valueJson: string;
  /** valueJson 字节数 */
  sizeBytes: number;
  updatedAt: string;
}

export interface AppVersionWithMeta extends AppVersionMeta {
  /** 是否当前发布版本 */
  isCurrent: boolean;
}

/**
 * 平台应用存储（spec 2026-09-25-app-platform-architecture）。
 * 产物文件不进库：库只存版本元数据，bundle 落 <appsDir>/<appId>/versions/<num>/。
 */
export interface AppStore {
  // ---- 应用 ----
  create(input: {
    id: string;
    userId: string;
    name: string;
    description: string;
    icon?: string;
    manifest: AppManifest;
    /** 责任管家（应用管家制）：创建 agent 自动落绑定；缺省=内置应用管家兜底 */
    managerAgentId?: string;
  }): Promise<PlatformApp>;
  get(appId: string): Promise<PlatformApp | undefined>;
  listByUser(userId: string): Promise<PlatformApp[]>;
  update(
    appId: string,
    patch: Partial<Pick<PlatformApp, "name" | "description" | "icon" | "manifest">> & {
      /** 管家绑定：null=清除（交还内置兜底）；undefined=保持不变（应用管家制 spec §3.1） */
      managerAgentId?: string | null;
    },
  ): Promise<PlatformApp | undefined>;
  delete(appId: string): Promise<void>;

  // ---- 版本 ----
  /** 落一条版本元数据；num 由 store 递增分配（同应用单调） */
  addVersion(appId: string, meta: Omit<AppVersionMeta, "appId" | "num">): Promise<AppVersionMeta>;
  listVersions(appId: string): Promise<AppVersionWithMeta[]>;
  getVersion(appId: string, num: number): Promise<AppVersionMeta | undefined>;
  /** 发布/回滚：把应用 currentVersion 指向指定版本；版本不存在返回 undefined */
  publishVersion(appId: string, num: number): Promise<PlatformApp | undefined>;

  // ---- 应用数据（KV，per-app 命名空间）----
  putData(entry: AppDataEntry): Promise<void>;
  getData(appId: string, key: string): Promise<AppDataEntry | undefined>;
  listData(appId: string): Promise<AppDataEntry[]>;
  deleteData(appId: string, key: string): Promise<boolean>;
  /** 该应用已用数据总字节数（配额判定用） */
  dataTotalBytes(appId: string): Promise<number>;

  // ---- 应用日志（网关面 + 前端面；spec 修订 2026-09-29）----
  appendLogs(appId: string, entries: AppLogEntry[]): Promise<void>;
  listLogs(appId: string, limit: number): Promise<AppLogRecord[]>;
}

/** 应用日志条目（写入形态；网关面带 method/path/status，前端面带 message） */
export interface AppLogEntry {
  source: "gateway" | "frontend";
  level: "info" | "warn" | "error";
  method?: string;
  path?: string;
  status?: number;
  message?: string;
  ts: string;
}

export interface AppLogRecord extends AppLogEntry {
  id: number;
  appId: string;
}

export interface AppLogQuery {
  appId: string;
  limit: number;
}
