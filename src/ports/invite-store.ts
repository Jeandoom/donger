import type { Invite } from "../domain/invite.js";

/** 邀请注册链接存储。token 是注册链接里的凭证，consume 必须原子（防并发超用）。 */
export interface InviteStore {
  migrate(): void;
  create(invite: Invite): Promise<void>;
  getByToken(token: string): Promise<Invite | undefined>;
  /** 属主视角的邀请列表（含已用尽/过期/禁用，前端自行展示状态） */
  listByCreator(userId: string): Promise<Invite[]>;
  /** 原子核销：未禁用、未过期、未用尽时 usedCount+1；返回是否成功 */
  consume(token: string, now: Date): Promise<boolean>;
  /** 属主禁用；返回是否命中 */
  disable(id: string, createdBy: string): Promise<boolean>;
}
