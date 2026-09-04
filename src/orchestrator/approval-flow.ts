import type { GateRouter } from "../domain/gate-router.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { ApprovalCard } from "../domain/types.js";
import type { ApprovalResolver } from "../ports/agent-runner.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { TaskStore } from "../ports/task-store.js";

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
): ApprovalResolver {
  return async (req) => {
    await store.updateStatus(req.taskId, nextStatus("running", "request_approval"));

    const gate = gates.getGate(req.gateId);
    const card: ApprovalCard = {
      gateId: req.gateId,
      title: `审批门：${gate?.description ?? req.gateId}`,
      summary: req.summary,
    };
    const result = await channel.requestApproval(threadId, card);

    if (result.comment && commentStore) {
      await commentStore
        .add(req.taskId, result.responderId ?? "unknown", result.comment)
        .catch(() => {});
    }

    await store.updateStatus(req.taskId, nextStatus("awaiting_approval", "resume"));
    return { approved: result.approved, reason: result.reason };
  };
}
