import { DWClient, type RobotTextMessage, TOPIC_ROBOT } from "dingtalk-stream";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import {
  buildSingleSendBody,
  createCardInstance,
  getAccessToken,
  sendSingleMessage,
  updateCardInstance,
} from "../util/dingtalk-api.js";
import { ChannelError } from "../util/errors.js";

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** AI 卡片模板 ID（钉钉开发者后台创建；有则用卡片，无则用文本 singleSend） */
  cardTemplateId?: string;
}

/** 钉钉机器人消息 → IncomingMessage 归一（MVP 仅 text） */
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

/** 通过类关键词（大小写不敏感） */
const APPROVE_RE = /^(通过|同意|确认|yes|y|ok|✅)/i;

/**
 * 钉钉 Channel。
 * 接收：Stream（DWClient + TOPIC_ROBOT）。发送：OpenAPI singleSend（主动、不过期）。
 * 审批：文本式——发 markdown 提示，监听该 thread 下一条消息作为决议（MVP；交互卡片留后续）。
 */
export class DingTalkChannel implements Channel {
  readonly id = "dingtalk";
  handler?: (msg: IncomingMessage) => void;
  private client?: DWClient;
  readonly recipients = new Map<string, string>();
  /** threadId → 累积文本 + 卡片 outTrackId（AI 卡片模式） */
  private readonly cardState = new Map<string, { outTrackId?: string; text: string }>();
  private readonly pendingApprovals = new Map<
    string,
    (d: { approved: boolean; reason?: string }) => void
  >();

  constructor(private readonly cfg: DingTalkConfig) {}

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
    const client = new DWClient({
      clientId: this.cfg.appKey,
      clientSecret: this.cfg.appSecret,
      debug: false,
    });
    client.registerCallbackListener(TOPIC_ROBOT, (msg) => {
      try {
        const robot = JSON.parse(msg.data) as RobotTextMessage;
        this.recipients.set(robot.conversationId, robot.senderStaffId);
        this.routeIncoming(normalizeDingTalkMessage(robot));
      } catch (e) {
        console.error("[dingtalk] 消息解析失败", e);
      }
      client.socketCallBackResponse(msg.headers.messageId, {});
    });
    this.client = client;
    void client.connect();
  }

  /** 路由入站消息：有 pending 审批则消费为决议，否则转发给 handler（新任务）。 */
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
    // AI 卡片模式：同 thread 累积文本，创建/更新同一张卡片
    if (this.cfg.cardTemplateId) {
      await this.sendViaCard(threadId, msg);
      return;
    }
    // 降级：文本 singleSend（无 cardTemplateId 时）
    const userId = this.recipients.get(threadId);
    if (!userId) {
      throw new ChannelError("NO_RECIPIENT", `钉钉无 ${threadId} 的 recipient`);
    }
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    const body = buildSingleSendBody(this.cfg.robotCode, userId, msg);
    await sendSingleMessage(token, body);
  }

  /** AI 卡片发送：首次创建卡片，后续更新同一张 */
  private async sendViaCard(threadId: string, msg: OutgoingMessage): Promise<void> {
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    let state = this.cardState.get(threadId);
    if (!state) {
      state = { text: "" };
      this.cardState.set(threadId, state);
    }
    // 累积文本
    state.text = state.text ? `${state.text}\n\n${msg.text}` : msg.text;

    if (!state.outTrackId) {
      // 首次：创建卡片
      try {
        state.outTrackId = await createCardInstance(token, {
          robotCode: this.cfg.robotCode,
          conversationId: threadId,
          cardTemplateId: this.cfg.cardTemplateId!,
          content: state.text,
          title: msg.text.slice(0, 30),
        });
      } catch (e) {
        // 卡片创建失败 → 降级到文本
        console.error("[dingtalk] createCardInstance 失败，降级到 singleSend", e);
        this.cardState.delete(threadId);
        const userId = this.recipients.get(threadId);
        if (userId) {
          const body = buildSingleSendBody(this.cfg.robotCode, userId, msg);
          await sendSingleMessage(token, body);
        }
      }
    } else {
      // 后续：更新卡片
      try {
        await updateCardInstance(token, {
          outTrackId: state.outTrackId,
          content: state.text,
          title: state.text.slice(0, 30),
        });
      } catch (e) {
        console.error("[dingtalk] updateCardInstance 失败", e);
      }
    }
  }

  /** 标记 thread 的卡片为完成（streaming=false）；供 Orchestrator 任务结束时调用 */
  async finalizeCard(threadId: string): Promise<void> {
    const state = this.cardState.get(threadId);
    if (!state?.outTrackId) return;
    this.cardState.delete(threadId);
    try {
      const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
      await updateCardInstance(token, {
        outTrackId: state.outTrackId,
        content: state.text,
        done: true,
      });
    } catch {
      // 忽略
    }
  }

  requestApproval(
    threadId: string,
    card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    // 先注册 pending（同步），再发提示；提示发送失败则 reject
    return new Promise((resolve, reject) => {
      this.pendingApprovals.set(threadId, resolve);
      void this.send(threadId, {
        text: `🔔 审批门：${card.title}\n${card.summary}\n\n请回复「通过」或「驳回」`,
        markdown: true,
      }).catch(reject);
    });
  }
}
