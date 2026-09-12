import type { AuditStore } from "../ports/audit-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { TaskStore } from "../ports/task-store.js";

export const RESTART_INTERRUPTED_REASON = "服务重启中断";
export const RESTART_AWAITING_REASON = "服务重启中断（审批/凭证挂起态随进程丢失）";

export interface RestartSweepResult {
  running: number;
  awaiting: number;
  /** 补发收尾消息的任务数（messageStore/auditStore 未装配时不补发） */
  notified: number;
}

export interface RestartSweepDeps {
  taskStore: TaskStore;
  messageStore?: MessageStore;
  auditStore?: AuditStore;
}

/**
 * 启动清扫：把上次进程遗留的 running/挂起门任务标记为中断，并给所属会话补一条收尾消息。
 * 此前只改任务状态，会话里永远停在「🔨 执行阶段」没有任何终止提示（复盘 P1-5 体验切片：
 * 挂起审批跨重启持久化属更大的机制改动，需另立设计规格，不在本函数范围）。
 */
export async function sweepInterruptedTasks(deps: RestartSweepDeps): Promise<RestartSweepResult> {
  const snapshot = [
    ...(await deps.taskStore.listByStatus("running")),
    ...(await deps.taskStore.listByStatus("awaiting_approval")),
    ...(await deps.taskStore.listByStatus("awaiting_credentials")),
  ];
  const running = await deps.taskStore.failStaleRunning(RESTART_INTERRUPTED_REASON);
  const awaiting = await deps.taskStore.failStaleAwaiting(RESTART_AWAITING_REASON);

  let notified = 0;
  for (const task of snapshot) {
    const reason =
      task.status === "running" ? RESTART_INTERRUPTED_REASON : RESTART_AWAITING_REASON;
    try {
      if (deps.messageStore) {
        await deps.messageStore.add(
          task.threadId,
          "bot",
          `❌ 该任务因服务重启被中断（${reason}），请重发任务继续。`,
        );
        notified++;
      }
      await deps.auditStore?.record({
        conversationId: task.threadId,
        taskId: task.id,
        userId: task.requesterId,
        seq: -1,
        type: "result",
        resultSubtype: "error",
        text: reason,
        recordedAt: new Date().toISOString(),
      });
    } catch {
      // 通知尽力而为，不阻断清扫
    }
  }
  return { running, awaiting, notified };
}
