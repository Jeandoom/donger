import type { GateRouter } from "../domain/gate-router.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { ApprovalCard } from "../domain/types.js";
import type { ApprovalResolver, QuestionResolver } from "../ports/agent-runner.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { NotificationService } from "./notification-service.js";

/**
 * 构造 approvalResolver：runner 命中门时——
 * 改状态 running→awaiting_approval → 推审批卡 → 等渠道决议 → 恢复 awaiting_approval→running
 * → 把渠道的 ApprovalResult 转成 runner 的 ApprovalDecision 返回。
 * 决议附带评论时落 task_comments（T17.3 验收门评论）。
 */
export function makeApprovalResolver(
  store: TaskStore,
  channel: Channel,
  threadId: string,
  gates: GateRouter,
  commentStore?: CommentStore,
  notifications?: NotificationService,
  ownerId?: string,
): ApprovalResolver {
  return async (req) => {
    const gate = gates.getGate(req.gateId);
    const card: ApprovalCard = {
      gateId: req.gateId,
      title: `审批门：${gate?.description ?? req.gateId}`,
      summary: req.summary,
    };
    // pendingGate 落库：重启清扫（failStaleAwaiting）与观测面板据此识别卡在人工门的任务
    await store.updateStatus(req.taskId, nextStatus("running", "request_approval"), {
      pendingGate: {
        gateId: req.gateId,
        title: card.title,
        requestedAt: new Date().toISOString(),
      },
    });

    // 通知收编（spec §6 M2）：审批请求 → 站内信+订阅站外；离线用户不再漏审批
    if (notifications && ownerId) {
      void notifications
        .notify({
          event: "approval.requested",
          recipients: [{ kind: "user", userId: ownerId }],
          title: card.title,
          body: req.summary.slice(0, 400),
          dedupeKey: `approval:${req.gateId}`,
        })
        .catch((e) => console.error("[approval-flow] 审批通知失败", e));
    }

    const result = await channel.requestApproval(threadId, card);

    if (result.comment && commentStore) {
      await commentStore
        .add(req.taskId, result.responderId ?? "unknown", result.comment)
        .catch(() => {});
    }

    await store.updateStatus(req.taskId, nextStatus("awaiting_approval", "resume"), {
      pendingGate: undefined,
    });
    return { approved: result.approved, reason: result.reason };
  };
}

/**
 * 构造 questionResolver：runner 命中 AskUserQuestion 时——
 * 渠道实现 requestUserInput 则推问题卡等作答；未实现/抛错（含超时）一律空答案降级，
 * 模型收到 "The user did not answer the questions." 自走默认假设分支（与历史行为一致）。
 */
export function makeQuestionResolver(channel: Channel, threadId: string): QuestionResolver {
  return async (req) => {
    if (!channel.requestUserInput) return { answers: {} };
    try {
      return await channel.requestUserInput(threadId, {
        taskId: req.taskId,
        conversationId: threadId,
        toolUseId: req.toolUseId,
        questions: req.questions,
      });
    } catch {
      return { answers: {} };
    }
  };
}
