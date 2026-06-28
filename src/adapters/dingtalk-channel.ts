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

/** 钉钉机器人消息 → IncomingMessage 归一（MVP 仅 text；threadId=conversationId，requesterId=senderStaffId） */
export function normalizeDingTalkMessage(m: RobotTextMessage): IncomingMessage {
  return {
    channelId: "dingtalk",
    threadId: m.conversationId,
    requesterId: m.senderStaffId,
    text: (m.text?.content ?? "").trim(),
  };
}

/**
 * 钉钉 Channel。
 * 接收：Stream 模式（DWClient + TOPIC_ROBOT）。
 * 发送：OpenAPI singleSend（主动、不过期，适合长任务/定时通知）。recipient id 用 senderStaffId（T3.5 实测确认）。
 * requestApproval 暂为 stub（T3.3 填）。
 */
export class DingTalkChannel implements Channel {
  readonly id = "dingtalk";
  private handler?: (msg: IncomingMessage) => void;
  private client?: DWClient;
  /** threadId(conversationId) → recipient userId(senderStaffId)。供主动发送用。 */
  readonly recipients = new Map<string, string>();

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
        this.handler?.(normalizeDingTalkMessage(robot));
      } catch (e) {
        console.error("[dingtalk] 消息解析失败", e);
      }
      client.socketCallBackResponse(msg.headers.messageId, {});
    });
    this.client = client;
    void client.connect();
  }

  stop(): void {
    this.client?.disconnect();
  }

  async send(threadId: string, msg: OutgoingMessage): Promise<void> {
    const userId = this.recipients.get(threadId);
    if (!userId) {
      throw new ChannelError(
        "NO_RECIPIENT",
        `钉钉无 ${threadId} 的 recipient（需先收到该用户消息以绑定 userId）`,
      );
    }
    const token = await getAccessToken(this.cfg.appKey, this.cfg.appSecret);
    const body = buildSingleSendBody(this.cfg.robotCode, userId, msg);
    await sendSingleMessage(token, body);
  }

  async requestApproval(
    _threadId: string,
    _card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    throw new ChannelError("NOT_IMPLEMENTED", "DingTalkChannel.requestApproval 未实现（见 T3.3）");
  }
}
