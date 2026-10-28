import { DWClient, type RobotTextMessage, TOPIC_ROBOT } from "dingtalk-stream";
import type { PlatformMessageEnvelope } from "../domain/event-payloads.js";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import {
  buildGroupSendBody,
  buildSingleSendBody,
  getAccessToken,
  sendGroupMessage,
  sendSingleMessage,
} from "../util/dingtalk-api.js";
import { ChannelError } from "../util/errors.js";

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
}

/** 会话 → 回复目标。conversationType=2（群）时 send 走 groupMessages/send 回源到群 */
interface DingTalkRecipient {
  userId: string;
  conversationType?: string;
  senderNick?: string;
}

/** 钉钉机器人消息 → IncomingMessage 归一 */
export function normalizeDingTalkMessage(m: RobotTextMessage): IncomingMessage {
  return {
    channelId: "dingtalk",
    threadId: m.conversationId,
    requesterId: m.senderStaffId,
    text: (m.text?.content ?? "")
      .trim()
      .replace(/^@\S+\s*/, "")
      .trim(),
  };
}

/** 钉钉群 @ 消息 → 平台统一信封（spec 2026-10-27-platform-message-subscription-design §4.3 D2） */
export function buildDingTalkGroupEnvelope(m: RobotTextMessage): PlatformMessageEnvelope {
  return {
    platform: "dingtalk",
    topic: "robot.group",
    eventId: m.msgId,
    occurredAt: new Date(m.createAt || Date.now()).toISOString(),
    sender: { id: m.senderStaffId, name: m.senderNick ?? "" },
    source: { openConversationId: m.conversationId, conversationType: m.conversationType },
    text: normalizeDingTalkMessage(m).text,
    raw: { robotCode: m.robotCode, isAdmin: m.isAdmin, msgtype: m.msgtype },
    replyAnchor: { platform: "dingtalk", kind: "group", threadId: m.conversationId },
  };
}

const APPROVE_RE = /^(通过|同意|确认|yes|y|ok|✅)/i;

export class DingTalkChannel implements Channel {
  readonly id = "dingtalk";
  handler?: (msg: IncomingMessage) => void;
  private client?: DWClient;
  readonly recipients = new Map<string, DingTalkRecipient>();
  private readonly pendingApprovals = new Map<
    string,
    (d: { approved: boolean; reason?: string }) => void
  >();
  /** 群消息路由口（spec §4.2 M1）：返回 true=被事件订阅消费（不进聊天）；缺省=全部走聊天 */
  private groupMessageHandler?: (envelope: PlatformMessageEnvelope) => Promise<boolean>;

  constructor(private readonly cfg: DingTalkConfig) {}

  onGroupMessage(handler: (envelope: PlatformMessageEnvelope) => Promise<boolean>): void {
    this.groupMessageHandler = handler;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
    const client = new DWClient({
      clientId: this.cfg.appKey,
      clientSecret: this.cfg.appSecret,
      debug: false,
    });
    client.registerCallbackListener(TOPIC_ROBOT, async (msg) => {
      try {
        const robot = JSON.parse(msg.data) as RobotTextMessage;
        // senderStaffId 可能为空（如未关联企业账号的临时会话），无法定位用户 → 忽略
        if (!robot.senderStaffId) {
          console.warn("[dingtalk] 忽略无 senderStaffId 的消息", {
            conversationId: robot.conversationId,
          });
          client.socketCallBackResponse(msg.headers.messageId, {});
          return;
        }
        this.recipients.set(robot.conversationId, {
          userId: robot.senderStaffId,
          conversationType: robot.conversationType,
          senderNick: robot.senderNick,
        });
        // 群 @ 消息先过事件订阅路由（消息事件化）：命中=消费（ACK 不进聊天）；
        // 无订阅/未命中 → 回落对话语义（M1 前的既有行为）
        if (robot.conversationType === "2" && this.groupMessageHandler) {
          let consumed = false;
          try {
            consumed = await this.groupMessageHandler(buildDingTalkGroupEnvelope(robot));
          } catch (e) {
            console.error("[dingtalk] 群消息路由失败，回落对话", e);
          }
          if (consumed) {
            client.socketCallBackResponse(msg.headers.messageId, {});
            return;
          }
        }
        this.routeIncoming(normalizeDingTalkMessage(robot));
      } catch (e) {
        console.error("[dingtalk] 消息解析失败", e);
      }
      client.socketCallBackResponse(msg.headers.messageId, {});
    });
    this.client = client;
    void client.connect();
  }

  routeIncoming(incoming: IncomingMessage): void {
    const pending = this.pendingApprovals.get(incoming.threadId);
    if (pending) {
      this.pendingApprovals.delete(incoming.threadId);
      const approved = APPROVE_RE.test(incoming.text.trim());
      pending({ approved, reason: approved ? undefined : `用户回复：${incoming.text}` });
      return;
    }
    this.handler?.(incoming);
  }

  stop(): void {
    this.client?.disconnect();
  }

  async send(threadId: string, msg: OutgoingMessage): Promise<void> {
    const recipient = this.recipients.get(threadId);
    if (!recipient) throw new ChannelError("NO_RECIPIENT", `钉钉无 ${threadId} 的 recipient`);
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    // 群消息回源：来源是群（conversationType=2）→ groupMessages/send 回到群里。
    // conversationId 作 openConversationId 属社区惯例（SDK 类型未声明该字段），
    // 失败（如 invalid.openConversationId）回退单聊，保证送达。
    if (recipient.conversationType === "2") {
      try {
        await sendGroupMessage(token, buildGroupSendBody(this.cfg.robotCode, threadId, msg));
        return;
      } catch (e) {
        console.warn(`[dingtalk] 群回复失败，回退单聊: ${(e as Error).message}`);
      }
    }
    await sendSingleMessage(token, buildSingleSendBody(this.cfg.robotCode, recipient.userId, msg));
  }

  requestApproval(
    threadId: string,
    card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(threadId, resolve);
      void this.send(threadId, {
        text: `🔔 审批门：${card.title}\n${card.summary}\n\n请回复「通过」或「驳回」`,
        markdown: true,
      }).catch(reject);
    });
  }
}
