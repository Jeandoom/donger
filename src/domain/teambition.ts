import type { PlatformMessageEnvelope } from "./event-payloads.js";

/**
 * Teambition 企业自建应用 Webhook 载荷（spec 2026-10-27-platform-message-subscription-design
 * §4.3 D2 / §9.2 文档核证）：
 * body = { orgId, timestamp(ms), event("task.update"等), eventId, hookId,
 *          data: { operatorId, task: { taskId, projectId, content, executorId, isDone… } } }
 * 全企业推送：订阅收窄由 MessageEventRouter 的 platform/topic+filter 承担（D6）。
 */
export interface TeambitionWebhookPayload {
  orgId?: string;
  timestamp?: number;
  event?: string;
  eventId?: string;
  hookId?: string;
  data?: {
    operatorId?: string;
    task?: {
      taskId?: string;
      projectId?: string;
      uid?: string;
      content?: string;
      note?: string;
      isDone?: boolean;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
}

/** TB 事件名白名单外原样透传（router 按 topic 匹配订阅，无订阅自然短路） */
export function buildTeambitionEnvelope(
  payload: TeambitionWebhookPayload,
): PlatformMessageEnvelope | undefined {
  const event = typeof payload.event === "string" ? payload.event : "";
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  const task = payload.data?.task;
  const taskId = typeof task?.taskId === "string" ? task.taskId : "";
  if (!event || !eventId || !taskId) return undefined;
  const occurredAt =
    typeof payload.timestamp === "number" && payload.timestamp > 0
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString();
  const title = typeof task?.content === "string" ? task.content.trim() : "";
  const text = title ? `任务「${title.slice(0, 80)}」${event}` : `任务 ${taskId} ${event}`;
  const orgId = typeof payload.orgId === "string" ? payload.orgId : "";
  return {
    platform: "teambition",
    topic: event,
    eventId,
    occurredAt,
    sender: {
      id: typeof payload.data?.operatorId === "string" ? payload.data.operatorId : "",
      name: "",
    },
    source: {
      orgId: orgId || undefined,
      projectId: typeof task?.projectId === "string" ? task.projectId : undefined,
      taskId,
    },
    text,
    // 原始裁剪：只保留排障所需标量（全量 body 不入库）
    raw: {
      hookId: payload.hookId,
      isDone: task?.isDone,
      operatorId: payload.data?.operatorId,
    },
    replyAnchor: { platform: "teambition", kind: "task", taskId, ...(orgId ? { orgId } : {}) },
  };
}
