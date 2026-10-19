import { randomUUID } from "node:crypto";
import type { GateRouter } from "../domain/gate-router.js";
import { buildHostExecAdoptDraft } from "../domain/host-exec-policy.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { ApprovalCard } from "../domain/types.js";
import type { ApprovalResolver, QuestionResolver } from "../ports/agent-runner.js";
import type { ApprovalStore } from "../ports/approval-store.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { NotificationService } from "./notification-service.js";

/**
 * 构造 approvalResolver：runner 命中门时——
 * 改状态 running→awaiting_approval → 推审批卡 → 等渠道决议 → 恢复 awaiting_approval→running
 * → 把渠道的 ApprovalResult 转成 runner 的 ApprovalDecision 返回。
 * 决议附带评论时落 task_comments（T17.3 验收门评论）。
 * ownerRole="admin" 且 host_exec 审批时卡片携带「一键成策略」草稿（specs/2026-10-12 §8.1 M2）。
 * 审批落库（热发布 M3，spec 2026-10-16-hot-deploy-design §6）：装配 approvalStore 时
 * **请求即落库**（pending 行与卡片同 approvalId），决议侧由 respond 路由/下方兜底双保险落库；
 * 重启后凭 DB 行重臂卡片、跨重启决议续跑。
 */
export function makeApprovalResolver(
  store: TaskStore,
  channel: Channel,
  threadId: string,
  gates: GateRouter,
  commentStore?: CommentStore,
  notifications?: NotificationService,
  ownerId?: string,
  ownerRole?: string,
  approvalStore?: ApprovalStore,
): ApprovalResolver {
  return async (req) => {
    const gate = gates.getGate(req.gateId);
    const card: ApprovalCard = {
      gateId: req.gateId,
      title: `审批门：${gate?.description ?? req.gateId}`,
      summary: req.summary,
    };
    if (
      ownerRole === "admin" &&
      req.gateId === "host-ops" &&
      req.tool === "mcp__donger-host__host_exec"
    ) {
      const draft = buildHostExecAdoptDraft(req.input, {});
      if (draft) card.adoptDraft = draft;
    }
    // pendingGate 落库：重启清扫（failStaleAwaiting）与观测面板据此识别卡在人工门的任务
    await store.updateStatus(req.taskId, nextStatus("running", "request_approval"), {
      pendingGate: {
        gateId: req.gateId,
        title: card.title,
        requestedAt: new Date().toISOString(),
      },
    });

    // 请求即落库（热发布 M3）：approvalId 在此生成（与渠道卡片同键），payload 存
    // 跨重启续跑/一键成策略所需的全量原材料；进程随时可死，行先行
    const approvalId = randomUUID();
    if (approvalStore) {
      await approvalStore
        .create({
          id: approvalId,
          taskId: req.taskId,
          conversationId: threadId,
          gateId: req.gateId,
          ...(req.tool ? { tool: req.tool } : {}),
          title: card.title,
          summary: req.summary,
          payload: JSON.stringify({
            input: req.input,
            toolUseId: req.toolUseId,
            ...(card.adoptDraft ? { adoptDraft: card.adoptDraft } : {}),
          }),
          channel: channel.id,
          status: "pending",
          createdAt: new Date().toISOString(),
        })
        .catch((e) => console.error("[approval-flow] 审批行落库失败（不阻断卡片）", e));
    }

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

    const result = await channel.requestApproval(threadId, card, approvalId);

    // 决议落库兜底（热发布 M3）：web respond 路由已先行落库（此处幂等跳过）；
    // dingtalk/CLI 等文本决议渠道没有 respond 路由，由这里补上唯一落库点
    if (approvalStore) {
      await approvalStore
        .decide(
          approvalId,
          result.approved ? "approved" : "rejected",
          {
            approved: result.approved,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.comment ? { comment: result.comment } : {}),
            ...(result.responderId ? { responderId: result.responderId } : {}),
            ...(result.adoptPrefix ? { adoptPrefix: result.adoptPrefix } : {}),
          },
          new Date().toISOString(),
        )
        .catch((e) => console.error("[approval-flow] 审批决议落库失败（不阻断执行）", e));
    }

    if (result.comment && commentStore) {
      await commentStore
        .add(req.taskId, result.responderId ?? "unknown", result.comment)
        .catch(() => {});
    }

    await store.updateStatus(req.taskId, nextStatus("awaiting_approval", "resume"), {
      pendingGate: undefined,
    });
    return {
      approved: result.approved,
      reason: result.reason,
      ...(result.adoptPrefix ? { adoptPrefix: result.adoptPrefix } : {}),
    };
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
