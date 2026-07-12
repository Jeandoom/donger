import type { TaskStatus } from "./types.js";

/** 状态机触发事件（状态机专属词汇，定义在本文件内） */
export type TaskEvent =
  | "plan"
  | "start"
  | "request_approval"
  | "resume"
  | "request_credentials"
  | "credentials_provided"
  | "finish"
  | "fail"
  | "cancel";

const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>> = {
  created: { plan: "planning", cancel: "canceled" },
  planning: {
    start: "running",
    request_credentials: "awaiting_credentials",
    cancel: "canceled",
  },
  running: {
    request_approval: "awaiting_approval",
    finish: "done",
    fail: "failed",
    cancel: "canceled",
  },
  awaiting_approval: { resume: "running", fail: "failed", cancel: "canceled" },
  awaiting_credentials: { credentials_provided: "planning", fail: "failed", cancel: "canceled" },
  done: {},
  failed: {},
  canceled: {},
};

export function canTransition(from: TaskStatus, ev: TaskEvent): boolean {
  return ev in (TRANSITIONS[from] ?? {});
}

/** 返回下一状态；非法转换抛普通 Error（domain 保持纯，不依赖 util） */
export function nextStatus(from: TaskStatus, ev: TaskEvent): TaskStatus {
  const next = TRANSITIONS[from]?.[ev];
  if (!next) throw new Error(`非法状态转换: ${from} --${ev}-->`);
  return next;
}
