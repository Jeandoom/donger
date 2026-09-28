import type { KbLibrary, KbLibraryInput, KbRevision, KbRevisionInput } from "../domain/kb.js";

export interface KbLibraryStore {
  create(input: KbLibraryInput): Promise<KbLibrary>;
  get(id: string): Promise<KbLibrary | undefined>;
  /** 本人名下全部库（含个人库），updatedAt 降序 */
  listByOwner(ownerId: string): Promise<KbLibrary[]>;
  /** 被分享授予的库（shares.enabled=1 联结） */
  listSharedWith(userId: string): Promise<KbLibrary[]>;
  /** 全量（内置库枚举/迁移器用） */
  listAll(): Promise<KbLibrary[]>;
  /** 每用户的个人知识库（personal=1，一人至多一个） */
  findPersonalByOwner(ownerId: string): Promise<KbLibrary | undefined>;
  /** agent「独立知识库」幂等回填用 */
  findBySourceAgent(sourceAgentId: string): Promise<KbLibrary | undefined>;
  update(id: string, patch: Partial<KbLibrary>): Promise<KbLibrary>;
  /** 仅删库记录（分享表级联）；文件目录与账本由 handler/util 负责（账本保留，spec §6.1） */
  delete(id: string): Promise<void>;
  /** 每用户个人库懒 ensure（幂等；UNIQUE 撞名时回读）——建号不侵入 user-store，首次可见即创建 */
  ensurePersonalLibrary(userId: string): Promise<KbLibrary>;
}

export interface KbShare {
  kbId: string;
  token: string;
  enabled: boolean;
  createdAt: string;
}

export interface KbShareGrant {
  kbId: string;
  userId: string;
  grantedAt: string;
}

export interface KbShareStore {
  getShare(kbId: string): Promise<KbShare | undefined>;
  enableShare(kbId: string): Promise<KbShare>;
  disableShare(kbId: string): Promise<void>;
  listGrants(kbId: string): Promise<KbShareGrant[]>;
  addGrant(kbId: string, userId: string): Promise<void>;
  removeGrant(kbId: string, userId: string): Promise<void>;
  isGranted(kbId: string, userId: string): Promise<boolean>;
  findByToken(token: string): Promise<{ kbId: string; enabled: boolean } | undefined>;
}

export interface KbRevisionListQuery {
  /** 传则按库过滤；不传 = 审计页全量（admin 口径由 handler 控） */
  kbId?: string;
  limit: number;
  offset: number;
}

export interface KbRevisionStore {
  /** 写入一条修订；同事务做保留策略裁剪（同 kbId+path 仅最近 50 条留 diff/summary，spec §6.1） */
  record(input: KbRevisionInput): Promise<KbRevision>;
  listByKb(
    kbId: string,
    opts?: { path?: string; limit?: number; offset?: number },
  ): Promise<KbRevision[]>;
  /** 审计页 member 口径：本人相关库集合（可管理∪被授予）的合并时间线（createdAt 降序） */
  listByKbIds(kbIds: readonly string[], limit: number, offset: number): Promise<KbRevision[]>;
  /** 审计页全量时间线（createdAt 降序） */
  listAll(query: KbRevisionListQuery): Promise<KbRevision[]>;
  countByKb(kbId: string): Promise<number>;
}
