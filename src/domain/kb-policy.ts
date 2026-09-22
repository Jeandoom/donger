import type { KbLibrary } from "./kb.js";

type Actor = { id: string; role: "admin" | "user" };

/**
 * 知识库权限口径单点收敛（spec §7 铁律）：全部 /api/kb* 端点从这里取判定，
 * 禁止 handler 内联重复属主/角色逻辑——散布是历史 P0 高发模式（messages/audit/users-memory）。
 */

/** 维护口径：admin 或属主。内置库 ownerId=__builtin__，admin 判定为真（D3：admin 可对话维护）。 */
export function canManageKb(kb: KbLibrary, user: Actor): boolean {
  return user.role === "admin" || kb.ownerId === user.id;
}

/** 使用口径：维护或被分享授予（kb_share_grants ⋈ kb_shares.enabled=1）。 */
export function canUseKb(kb: KbLibrary, user: Actor, isGranted: boolean): boolean {
  return canManageKb(kb, user) || isGranted;
}

/** 读口径：内置库（系统默认）全员可读，其余走使用口径。 */
export function canReadKb(kb: KbLibrary, user: Actor, isGranted: boolean): boolean {
  return kb.builtin || canUseKb(kb, user, isGranted);
}

/** 分享面禁入：个人库含经验记忆（防泄漏）、内置库属系统资产。 */
export function kbShareable(kb: KbLibrary): boolean {
  return !kb.personal && !kb.builtin;
}

/** 删除面禁入：同分享面（builtin/personal 不可删；删除时账本保留，见 spec §6.1）。 */
export const kbDeletable = kbShareable;
