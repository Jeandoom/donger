import { DWClient, type RobotTextMessage, TOPIC_ROBOT } from "dingtalk-stream";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import {
  buildSingleSendBody,
  createAndDeliverCard,
  getAccessToken,
  sendSingleMessage,
  streamCardUpdate,
} from "../util/dingtalk-api.js";
import { ChannelError } from "../util/errors.js";

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
  /** AI 卡片模板 ID（有则用卡片流式回复，无则降级文本） */
  cardTemplateId?: string;
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

const APPROVE_RE = /^(通过|同意|确认|yes|y|ok|✅)/i;

export class DingTalkChannel implements Channel {
  readonly id = "dingtalk";
  handler?: (msg: IncomingMessage) => void;
  private client?: DWClient;
  readonly recipients = new Map<string, string>();
  /** threadId → 卡片流式状态（累积文本 + outTrackId） */
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
    // AI 卡片模式
    if (this.cfg.cardTemplateId) {
      await this.sendViaCard(threadId, msg);
      return;
    }
    // 降级：文本 singleSend
    const userId = this.recipients.get(threadId);
    if (!userId) throw new ChannelError("NO_RECIPIENT", `钉钉无 ${threadId} 的 recipient`);
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    await sendSingleMessage(token, buildSingleSendBody(this.cfg.robotCode, userId, msg));
  }

  /**
   * AI 卡片流式发送：
   * 首次 send → createAndDeliverCard（创建卡片+投递到会话）
   * 后续 send → streamCardUpdate（累积文本，流式更新卡片内容）
   */
  private async sendViaCard(threadId: string, msg: OutgoingMessage): Promise<void> {
    const userId = this.recipients.get(threadId);
    if (!userId) throw new ChannelError("NO_RECIPIENT", `钉钉无 ${threadId} 的 recipient`);

    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    let state = this.cardState.get(threadId);
    if (!state) {
      state = { text: "" };
      this.cardState.set(threadId, state);
    }

    // 累积文本
    state.text = state.text ? `${state.text}\n\n${msg.text}` : msg.text;

    if (!state.outTrackId) {
      // 首次：createAndDeliver（创建+投递）
      console.log("[dingtalk-card] 首次创建卡片，content:", state.text.slice(0, 50));
      try {
        state.outTrackId = await createAndDeliverCard(token, {
          userId,
          robotCode: this.cfg.robotCode,
          cardTemplateId: this.cfg.cardTemplateId!,
          content: state.text,
          title: msg.text.slice(0, 30),
        });
        console.log("[dingtalk-card] 创建成功，outTrackId:", state.outTrackId);
      } catch (e) {
        console.error("[dingtalk-card] createAndDeliverCard 失败:", e);
        this.cardState.delete(threadId);
        await sendSingleMessage(token, buildSingleSendBody(this.cfg.robotCode, userId, msg));
      }
    } else {
      // 后续：流式更新
      console.log("[dingtalk-card] 更新卡片，text len:", state.text.length);
      try {
        await streamCardUpdate(token, {
          outTrackId: state.outTrackId,
          content: state.text,
        });
      } catch (e) {
        console.error("[dingtalk-card] streamCardUpdate 失败:", e);
      }
    }
  }

  /** 任务结束时调用：标记卡片完成 */
  async finalizeCard(threadId: string): Promise<void> {
    const state = this.cardState.get(threadId);
    if (!state?.outTrackId) return;
    this.cardState.delete(threadId);
    try {
      const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
      await streamCardUpdate(token, {
        outTrackId: state.outTrackId,
        content: state.text,
        isFinal: true,
      });
    } catch {
      // 忽略
    }
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
