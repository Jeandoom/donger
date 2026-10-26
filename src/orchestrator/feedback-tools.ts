// donger-feedback 反馈闭环工具（spec 2026-10-20-feedback-notify-loop §M1）：
// 无人值守反馈处理链路的沉淀出口——处理结论写回反馈单（feedback_replies 沉淀 +
// feedback.replied 站内信，2026-10-20 拍板①）并按需推进状态机。
// 写边界 = correlation 白名单：工具只可操作发起本轮 run 的那个 feedbackId
// （构造时闭包绑定），普通聊天轮不挂载、模型传其他 feedbackId 一律拒绝（防 IDOR）。
// 状态推进单向递增（open→accepted→resolved→closed）；提 MR 路径的 resolved 由
// ReleaseService 管线负责，提示词约束 agent 此时不 markStatus。

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  FEEDBACK_STATUSES,
  type Feedback,
  type FeedbackReply,
  type FeedbackStatus,
  isFeedbackStatus,
} from "../domain/feedback.js";
import type { FeedbackStore } from "../ports/feedback-store.js";
import type { NotificationService } from "./notification-service.js";

export interface FeedbackToolsDeps {
  /** 发起本轮 run 的用户（工作流属主）：回复行 userId 落此值，authorRole 固定 "system" */
  viewer: { id: string };
  feedbackStore: FeedbackStore;
  /** 通知内核（缺省=不发站内信） */
  notifications?: NotificationService;
  /** correlation 写边界：仅此反馈可读写 */
  allowedFeedbackId: string;
}

/** MCP 工具返回（结构兼容 SDK CallToolResult，避免依赖其类型导出） */
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** 反馈回复正文字符上限（写回工具与通知轮兜底共用） */
export const REPLY_MAX_CHARS = 2000;

/**
 * 反馈状态机单向递增校验（工具侧收紧；admin 手工 PATCH 端点维持现状不收）。
 * same=幂等（已处于目标态），backward=回退拒绝，ok=可推进。
 */
export function feedbackStatusAdvance(
  current: FeedbackStatus,
  next: FeedbackStatus,
): "ok" | "same" | "backward" {
  const ci = FEEDBACK_STATUSES.indexOf(current);
  const ni = FEEDBACK_STATUSES.indexOf(next);
  if (ni < ci) return "backward";
  if (ni === ci) return "same";
  return "ok";
}

function guardFeedbackId(deps: FeedbackToolsDeps, feedbackId: unknown): string | null {
  if (typeof feedbackId !== "string" || feedbackId !== deps.allowedFeedbackId) {
    return `仅可操作本次处理的反馈（${deps.allowedFeedbackId}），拒绝写入其他反馈单`;
  }
  return null;
}

function replyRow(deps: FeedbackToolsDeps, feedbackId: string, content: string): FeedbackReply {
  return {
    id: crypto.randomUUID(),
    feedbackId,
    userId: deps.viewer.id,
    authorRole: "system",
    content,
    createdAt: new Date().toISOString(),
  };
}

/** 写回复 + 触达提交人站内信（自己处理自己提交的反馈不发） */
async function deliverReplyNotice(
  deps: FeedbackToolsDeps,
  fb: Feedback,
  reply: FeedbackReply,
): Promise<void> {
  if (fb.userId === deps.viewer.id || !deps.notifications) return;
  await deps.notifications
    .notify({
      event: "feedback.replied",
      recipients: [{ kind: "user", userId: fb.userId }],
      title: "你的反馈有自动处理结果",
      body: reply.content.slice(0, 200),
      link: `/feedback?focus=${fb.id}`,
      dedupeKey: `fb:${fb.id}:${reply.id}`,
    })
    .catch((e: unknown) => console.error("[feedback-tools] 回复通知失败", e));
}

const FeedbackIdShape = {
  feedbackId: z.string().min(1).describe("反馈单 id（只可使用事件中给定的那个）"),
};

/** 三个反馈闭环工具定义（导出供单测直接调 handler） */
export function feedbackToolDefinitions(deps: FeedbackToolsDeps): SdkMcpToolDefinition[] {
  return [
    {
      name: "feedback_get",
      description: "读取本次处理的反馈单详情与全部回复（含管理员/提交人历史往来）",
      inputSchema: FeedbackIdShape,
      handler: async ({ feedbackId }) => {
        const denied = guardFeedbackId(deps, feedbackId);
        if (denied) return fail(denied);
        const fb = await deps.feedbackStore.get(feedbackId);
        if (!fb) return fail(`反馈单不存在: ${feedbackId}`);
        const replies = await deps.feedbackStore.listReplies(feedbackId);
        return ok(JSON.stringify({ feedback: fb, replies }, null, 2));
      },
    },
    {
      name: "feedback_add_reply",
      description:
        "把处理结论写回反馈单（提交人会在反馈页看到并收到站内信）。markStatus 可选同时推进状态；已提修复 MR 时不要传 markStatus（合并/发布由管线推进）",
      inputSchema: {
        ...FeedbackIdShape,
        content: z.string().min(1).max(REPLY_MAX_CHARS).describe("回复正文（markdown，≤2000 字）"),
        markStatus: z
          .enum(["accepted", "resolved", "closed"])
          .optional()
          .describe("写回复同时推进到的状态（单向递增）"),
      },
      handler: async ({ feedbackId, content, markStatus }) => {
        const denied = guardFeedbackId(deps, feedbackId);
        if (denied) return fail(denied);
        const fb = await deps.feedbackStore.get(feedbackId);
        if (!fb) return fail(`反馈单不存在: ${feedbackId}`);
        const body = content.trim();
        if (!body) return fail("content 不能为空白");
        const reply = replyRow(deps, feedbackId, body.slice(0, REPLY_MAX_CHARS));
        await deps.feedbackStore.addReply(reply);
        let statusNote = "";
        if (markStatus) {
          const verdict = feedbackStatusAdvance(fb.status, markStatus);
          if (verdict === "backward") {
            statusNote = `；状态推进被拒（${fb.status} → ${markStatus} 为回退）`;
          } else if (verdict === "same") {
            statusNote = `；状态已是 ${markStatus}`;
          } else {
            await deps.feedbackStore.updateStatus(feedbackId, markStatus);
            statusNote = `；状态已推进 ${fb.status} → ${markStatus}`;
          }
        }
        await deliverReplyNotice(deps, fb, reply);
        return ok(`回复已写入反馈单${statusNote}`);
      },
    },
    {
      name: "feedback_update_status",
      description: "推进反馈状态（单向递增 open→accepted→resolved→closed，不可回退）",
      inputSchema: {
        ...FeedbackIdShape,
        status: z.enum(["accepted", "resolved", "closed"]).describe("目标状态"),
      },
      handler: async ({ feedbackId, status }) => {
        const denied = guardFeedbackId(deps, feedbackId);
        if (denied) return fail(denied);
        if (!isFeedbackStatus(status)) return fail(`status 无效: ${String(status)}`);
        const fb = await deps.feedbackStore.get(feedbackId);
        if (!fb) return fail(`反馈单不存在: ${feedbackId}`);
        const verdict = feedbackStatusAdvance(fb.status, status);
        if (verdict === "backward") {
          return fail(`不允许回退：${fb.status} → ${status}`);
        }
        if (verdict === "same") return ok(`状态已是 ${status}`);
        await deps.feedbackStore.updateStatus(feedbackId, status);
        return ok(`状态已推进 ${fb.status} → ${status}`);
      },
    },
  ];
}

/** 构造 in-process 反馈工具 MCP server（注入 RunOptions.feedbackTools） */
export function createFeedbackToolsServer(deps: FeedbackToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-feedback",
    version: "0.1.0",
    tools: feedbackToolDefinitions(deps),
  });
}
