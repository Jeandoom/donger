import type { AuditStore } from "../ports/audit-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { TaskStore } from "../ports/task-store.js";

export const RESTART_INTERRUPTED_REASON = "服务重启中断";
export const RESTART_AWAITING_REASON = "服务重启中断（审批/凭证挂起态随进程丢失）";

export interface RestartSweepResult {
  running: number;
  /** awaiting_approval 且决议已持久化：已触发续跑 */
  resumed: number;
  /** awaiting_approval 保留挂起（无决议或续跑未就绪，决议可经 respond 回退路径写入） */
  rearmed: number;
}

export interface RestartSweepDeps {
  taskStore: TaskStore;
  messageStore?: MessageStore;
  auditStore?: AuditStore;
  /** 持久化门决议续跑入口（按 channelId 解析对应渠道的 orchestrator）；
   *  缺省=决议仅保留，待下次重启清扫续跑（specs/2026-09-12-durable-gate-design.md §2.3） */
  resumeGatedTask?: (taskId: string, channelId: string) => Promise<unknown>;
}

/**
 * 启动清扫语义（specs/2026-09-12-durable-gate-design.md §2.3）：
 * - running：LLM 轮真死无续跑依据 → 标失败 + 会话补收尾消息（修复「永远停在🔨执行阶段」）；
 * - awaiting_approval：不再标失败——有持久化决议即续跑，无决议保留挂起并补提示
 *   （决议可经 POST /api/approvals/:id/respond 回退路径写入）；
 * - awaiting_credentials：不触碰（其「暂停等用户配置后重发」语义本就不该被清除，
 *   旧清扫违背设计直接标失败）。
 */
export async function sweepInterruptedTasks(deps: RestartSweepDeps): Promise<RestartSweepResult> {
  const { taskStore } = deps;
  const runningTasks = await taskStore.listByStatus("running");
  const gatedTasks = await taskStore.listByStatus("awaiting_approval");
  const running = await taskStore.failStaleRunning(RESTART_INTERRUPTED_REASON);

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

  let resumed = 0;
  let rearmed = 0;
  for (const task of gatedTasks) {
    if (task.pendingGate?.decision && deps.resumeGatedTask) {
      try {
        const result = await deps.resumeGatedTask(task.id, task.channelId);
        if (result === "resumed") {
          resumed += 1;
          continue;
        }
      } catch {
        // 续跑失败 → 落入保留挂起，决议仍持久化，可经回退路径或下次重启再续
      }
    }
    rearmed += 1;
    const gateTitle = task.pendingGate?.title;
    await notifySweep(
      deps,
      task.threadId,
      task.id,
      task.requesterId,
      gateTitle
        ? `⏸️ 该任务在服务重启前正在等待「${gateTitle}」，审批仍然有效，可继续批准或驳回（将从已保存的进度继续）。`
        : "⏸️ 该任务在服务重启前正在等待审批，审批仍然有效，可继续批准或驳回。",
      "服务重启，审批门保留挂起",
    );
  }
  return { running, resumed, rearmed };
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
