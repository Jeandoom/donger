import type { UserRole } from "./user.js";

/**
 * 访问者视图：HTTP 层鉴权产物，授权判定的唯一身份形态。
 * role 与 domain/user.ts 的 UserRole 对齐；store 不感知 admin 语义。
 */
export interface Viewer {
  id: string;
  role: UserRole;
}

/**
 * 访问规则：路由守卫表每条路由必填其一（fail-closed——未声明即拒绝）。
 *  - public：免认证（显式枚举，评审可见）
 *  - authenticated：仅需登录
 *  - owner：资源属主（admin 直通；资源不存在由守卫统一转 404，防存在性泄漏）
 *  - admin：仅管理员
 */
export type AccessRule =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "owner"; resource: OwnedResourceKind }
  | { kind: "admin" };

/** 可按属主判定的资源类型（守卫表 owner 规则引用；仅作审计可读性标注） */
export type OwnedResourceKind =
  | "conversation"
  | "task"
  | "agent"
  | "trigger"
  | "workflow"
  | "loop"
  | "connector"
  | "invite"
  | "user-memory"
  | "callback"
  | "credential";

/**
 * 统一授权判定（纯函数，全量单测）。
 * ownerId 缺省仅对 owner 规则有意义：视为资源不存在，交由调用方转 404，
 * 此处不放行（fail-closed：查不到属主 ≠ 公开）。
 */
export function canAccess(viewer: Viewer | null, rule: AccessRule, ownerId?: string): boolean {
  switch (rule.kind) {
    case "public":
      return true;
    case "authenticated":
      return viewer !== null;
    case "owner":
      if (viewer === null) return false;
      if (viewer.role === "admin") return true;
      return ownerId !== undefined && ownerId === viewer.id;
    case "admin":
      return viewer?.role === "admin";
  }
}
