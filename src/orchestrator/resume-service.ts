/**
 * 中断自动续跑服务（热发布 M2，spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md §5.3）
 *
 * 启动清扫把 running 孤儿标 interrupted 后，本服务统一决定每条任务的去向：
 * - 可续跑（Web 渠道、会话存活未归档、非工作流运行会话、开关开、未超上限）→ 合成恢复指令
 *   经 submit（=orchestrator.handleMessage + resumeTaskId）续跑，复用原 task 行（D3 拍板）；
 * - 不可续跑 → 标 failed + 会话通知（沿用清扫提示口径）。
 * 续跑轮生命周期长：调用方在 submit 内自行 fire-and-forget，本函数只等投递完成。
 */
import type { IncomingMessage, Task } from "../domain/types.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { TaskStore } from "../ports/task-store.js";

/** 工作流运行会话标题前缀（event-dispatcher.execute 创建时固定）：这类轮由
 *  EventDispatcher.restore 的 at-least-once 重投接管，续跑会造成双跑，必须排除 */
const WORKFLOW_CONV_TITLE_PREFIX = "⚙️";

export const RESUME_SYNTHETIC_PROMPT =
  "[系统恢复] 服务更新重启，上一任务在执行中被暂停。请基于会话中已有的进展继续完成任务，" +
  "不要重复已完成的步骤；如关键上下文缺失，先向用户说明再继续。";

export const ABANDON_REASON = "服务重启中断（未满足自动续跑条件），请重发任务继续。";

export interface ResumeServiceDeps {
  taskStore: TaskStore;
  conversationStore: ConversationStore;
  messageStore?: MessageStore;
  auditStore?: AuditStore;
  /** 续跑投递入口（=orchestrator.handleMessage）；轮生命周期长，实现内应 fire-and-forget */
  submit: (msg: IncomingMessage) => void;
  autoResume: boolean;
  /** 单次启动续跑上限（熔断，避免重启风暴连环拉起大量长任务；新任务优先） */
  maxResume?: number;
}

export interface ResumeResult {
  resumed: number;
  abandoned: number;
}

export async function autoResumeInterruptedTasks(
  deps: ResumeServiceDeps,
): Promise<ResumeResult> {
  const { taskStore, conversationStore, submit, autoResume } = deps;
  const tasks = await taskStore.listByStatus("interrupted");
  if (tasks.length === 0) return { resumed: 0, abandoned: 0 };
  // 新任务优先恢复（ updatedAt 降序：越近被中断的越可能还在用户的注意窗口里）
  const ordered = [...tasks].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const maxResume = deps.maxResume ?? 5;
  let resumed = 0;
  let abandoned = 0;
  for (const task of ordered) {
    const eligible =
      autoResume && resumed < maxResume && (await isResumable(conversationStore, task));
    if (!eligible) {
      await abandon(deps, task);
      abandoned += 1;
      continue;
    }
    // 会话内可见的恢复提示（尽力而为）：用户回来能看到任务不是丢了而是自动接续了
    await deps.messageStore
      ?.add(task.threadId, "bot", "♻️ 服务更新完成，检测到被中断的任务，已自动恢复执行。")
      .catch(() => undefined);
    submit({
      channelId: "web",
      threadId: task.threadId,
      conversationId: task.threadId,
      requesterId: task.requesterId,
      text: RESUME_SYNTHETIC_PROMPT,
      resumeTaskId: task.id,
    });
    resumed += 1;
  }
  return { resumed, abandoned };
}

async function isResumable(
  conversationStore: ConversationStore,
  task: Task,
): Promise<boolean> {
  try {
    const conv = await conversationStore.get(task.threadId);
    if (!conv || conv.archived) return false;
    // 钉钉/CLI 轮的续跑需 thread 路由设计，v1 仅 Web（spec D7）；不满足→弃恢复
    if (conv.channelId !== "web") return false;
    if (conv.title.startsWith(WORKFLOW_CONV_TITLE_PREFIX)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 弃恢复收尾：标 failed + 会话通知 + 审计（尽力而为，不阻断其余任务处理） */
async function abandon(deps: ResumeServiceDeps, task: Task): Promise<void> {
  try {
    await deps.taskStore.updateStatus(task.id, "failed", { error: ABANDON_REASON });
    await deps.messageStore?.add(
      task.threadId,
      "bot",
      `❌ 该任务因服务重启被中断，且不满足自动续跑条件（非 Web 会话/会话已归档/超出续跑上限/续跑开关关闭），请重发任务继续。`,
    );
    await deps.auditStore?.record({
      conversationId: task.threadId,
      taskId: task.id,
      userId: task.requesterId,
      seq: -1,
      type: "result",
      resultSubtype: "error",
      text: "服务重启中断（未续跑）",
      recordedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[resume] 弃恢复收尾失败", task.id, e);
  }
}
