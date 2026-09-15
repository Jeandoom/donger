import type { AuditStore } from "../ports/audit-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { TaskStore } from "../ports/task-store.js";

export const RESTART_INTERRUPTED_REASON = "服务重启中断";
export const RESTART_AWAITING_REASON = "服务重启中断（审批挂起态随进程丢失）";

export interface RestartSweepResult {
  running: number;
  awaitingApproval: number;
}

export interface RestartSweepDeps {
  taskStore: TaskStore;
  messageStore?: MessageStore;
  auditStore?: AuditStore;
}

/**
 * 启动清扫：running 与 awaiting_approval 任务在进程重启后均无续跑依据（LLM 轮与
 * 工具门决议的 resolver 都在内存），统一标失败并补会话提示；awaiting_credentials
 * 不触碰（其「暂停等用户配置后重发」语义本就不该被清除）。
 */
export async function sweepInterruptedTasks(deps: RestartSweepDeps): Promise<RestartSweepResult> {
  const { taskStore } = deps;
  const runningTasks = await taskStore.listByStatus("running");
  const gatedTasks = await taskStore.listByStatus("awaiting_approval");
  const running = await taskStore.failStaleRunning(RESTART_INTERRUPTED_REASON);
  // 精确只转 awaiting_approval：failStaleAwaiting 会连 awaiting_credentials 一起清
  let awaitingApproval = 0;
  for (const task of gatedTasks) {
    await taskStore.updateStatus(task.id, "failed", {
      error: RESTART_AWAITING_REASON,
      pendingGate: undefined,
    });
    awaitingApproval += 1;
  }

  for (const task of runningTasks) {
    await notifySweep(
      deps,
      task.threadId,
      task.id,
      task.requesterId,
      `❌ 该任务因服务重启被中断（${RESTART_INTERRUPTED_REASON}），请重发任务继续。`,
      RESTART_INTERRUPTED_REASON,
    );
  }
  for (const task of gatedTasks) {
    const gateTitle = task.pendingGate?.title;
    await notifySweep(
      deps,
      task.threadId,
      task.id,
      task.requesterId,
      gateTitle
        ? `❌ 该任务在服务重启前正在等待「${gateTitle}」，审批状态已随重启失效，请重发任务继续。`
        : `❌ 该任务在服务重启前正在等待审批，审批状态已随重启失效，请重发任务继续。`,
      RESTART_AWAITING_REASON,
    );
  }
  return { running, awaitingApproval };
}

/** 写一条会话提示 + result:error 审计（尽力而为，不阻断清扫） */
async function notifySweep(
  deps: RestartSweepDeps,
  conversationId: string,
  taskId: string,
  userId: string,
  text: string,
  auditText: string,
): Promise<void> {
  try {
    await deps.messageStore?.add(conversationId, "bot", text);
    await deps.auditStore?.record({
      conversationId,
      taskId,
      userId,
      seq: -1,
      type: "result",
      resultSubtype: "error",
      text: auditText,
      recordedAt: new Date().toISOString(),
    });
  } catch {
    // 尽力而为
  }
}
