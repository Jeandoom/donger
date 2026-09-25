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
  }): Promise<PlatformApp>;
  get(appId: string): Promise<PlatformApp | undefined>;
  listByUser(userId: string): Promise<PlatformApp[]>;
  update(
    appId: string,
    patch: Partial<Pick<PlatformApp, "name" | "description" | "icon" | "manifest">>,
  ): Promise<PlatformApp | undefined>;
  delete(appId: string): Promise<void>;

  // ---- 版本 ----
  /** 落一条版本元数据；num 由 store 递增分配（同应用单调） */
  addVersion(
    appId: string,
    meta: Omit<AppVersionMeta, "appId" | "num">,
  ): Promise<AppVersionMeta>;
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
}
