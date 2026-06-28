import { DWClient, type RobotTextMessage, TOPIC_ROBOT } from "dingtalk-stream";
import type { ApprovalCard, IncomingMessage, OutgoingMessage } from "../domain/types.js";
import type { Channel } from "../ports/channel.js";
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
 * 钉钉 Channel（T3.1 只实现接收侧：Stream 模式收机器人消息）。
 * send / requestApproval 暂为 stub（T3.2 / T3.3 填）。真实 Stream 连接验证在 T3.5。
 */
export class DingTalkChannel implements Channel {
  readonly id = "dingtalk";
  private handler?: (msg: IncomingMessage) => void;
  private client?: DWClient;

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
        this.handler?.(normalizeDingTalkMessage(robot));
      } catch (e) {
        console.error("[dingtalk] 消息解析失败", e);
      }
      // 应答避免服务端 60s 重试
      client.socketCallBackResponse(msg.headers.messageId, {});
    });
    this.client = client;
    void client.connect();
  }

  /** 断开 Stream 连接 */
  stop(): void {
    this.client?.disconnect();
  }

  async send(_threadId: string, _msg: OutgoingMessage): Promise<void> {
    throw new ChannelError("NOT_IMPLEMENTED", "DingTalkChannel.send 未实现（见 T3.2）");
  }

  async requestApproval(
    _threadId: string,
    _card: ApprovalCard,
  ): Promise<{ approved: boolean; reason?: string }> {
    throw new ChannelError("NOT_IMPLEMENTED", "DingTalkChannel.requestApproval 未实现（见 T3.3）");
  }
}
