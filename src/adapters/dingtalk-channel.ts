import { DWClient, type RobotTextMessage, TOPIC_ROBOT } from "dingtalk-stream";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
import { buildSingleSendBody, getAccessToken, sendSingleMessage } from "../util/dingtalk-api.js";
import { ChannelError } from "../util/errors.js";

export interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  robotCode: string;
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
    const userId = this.recipients.get(threadId);
    if (!userId) throw new ChannelError("NO_RECIPIENT", `钉钉无 ${threadId} 的 recipient`);
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    await sendSingleMessage(token, buildSingleSendBody(this.cfg.robotCode, userId, msg));
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
