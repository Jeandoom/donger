/**
 * 系统事件存储端口（spec 2026-09-21-user-management-design 决策③）：
 * 审计页「事件」栏的数据源——记录与管理员动作相关的系统级重要事件
 * （角色变更等）。与 conversation 维度的 audit_events 是两张表、两个口径：
 * 这里有 actor/target、无 conversationId。
 */
export interface SystemEvent {
  id: string;
  /** 事件类型（如 user_role_change）；前端据此选图标与文案 */
  type: string;
  /** 操作者（发起变更的管理员） */
  actorId: string;
  actorName: string;
  /** 受影响用户（角色类事件的目标；其他事件类型可空） */
  targetUserId?: string;
  targetUserName?: string;
  /** 人类可读描述（落库前已组装好，前端直接展示） */
  detail: string;
  createdAt: string;
}

export interface SystemEventStore {
  /** 追加一条系统事件；createdAt 缺省取当前时间 */
  record(e: Omit<SystemEvent, "id" | "createdAt"> & { createdAt?: string }): Promise<SystemEvent>;
  /** 最近事件（新的在前） */
  list(limit?: number): Promise<SystemEvent[]>;
}
