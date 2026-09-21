import { apiFetch } from "./auth";

/**
 * 用户管理 + 系统事件 API（spec 2026-09-21-user-management-design）：
 * - 用户列表/角色变更是授权页「用户管理」区块的数据面（admin 专属，接口侧守卫 fail-closed）
 * - 系统事件是审计页「事件」栏的数据源（admin 专属）
 */

export interface AdminUserIdentity {
  provider: string;
  externalId: string;
  name?: string;
  avatar?: string;
}

export interface AdminUser {
  id: string;
  name: string;
  role: "admin" | "user";
  avatar?: string;
  createdAt: string;
  updatedAt: string;
  identities: AdminUserIdentity[];
}

/** 全量用户（DTO：不含 homeDir；403=非管理员） */
export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const r = await apiFetch("/api/admin/users");
  if (!r.ok) throw new Error(`加载用户列表失败：HTTP ${r.status}`);
  return (await r.json()) as AdminUser[];
}

/**
 * 变更用户角色。被拒时抛出后端原因文案：
 * 自改（409）/ 白名单用户不可取消（409）/ 最后一位管理员（409）。
 */
export async function updateUserRole(userId: string, role: "admin" | "user"): Promise<AdminUser> {
  const r = await apiFetch(`/api/admin/users/${userId}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  const data = (await r.json().catch(() => ({}))) as { user?: AdminUser; error?: string };
  if (!r.ok || !data.user) throw new Error(data.error ?? `变更失败（HTTP ${r.status}）`);
  return data.user;
}

export interface SystemEvent {
  id: string;
  type: string;
  actorId: string;
  actorName: string;
  targetUserId?: string;
  targetUserName?: string;
  detail: string;
  createdAt: string;
}

export async function fetchSystemEvents(): Promise<SystemEvent[]> {
  const r = await apiFetch("/api/admin/system-events");
  if (!r.ok) throw new Error(`加载系统事件失败：HTTP ${r.status}`);
  return ((await r.json()) as { events: SystemEvent[] }).events;
}
