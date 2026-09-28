import { type DingTalkModuleConfig, dingTalkRobotReady } from "../domain/module-config.js";
import type { OutboundNotification } from "../ports/notification-channel.js";
import {
  clipError,
  type DeliveryOutcome,
  type NotificationChannelAdapter,
} from "../ports/notification-channel.js";
import { getAccessToken, sendSingleMessage } from "../util/dingtalk-api.js";

/**
 * 钉钉主动推送适配器（spec §4.2/§10 M2）：复用授权页钉钉三方配置（appKey/appSecret/robotCode），
 * 机器人单聊 oToMessages 投递。地址=staffId（钉钉登录身份 externalId 或验证过的手填地址）。
 * 与会话通道 dingtalk-channel 的差异：不依赖入站消息的 recipients 内存映射，可主动触达。
 */
export class DingTalkNotificationAdapter implements NotificationChannelAdapter {
  readonly id = "dingtalk" as const;

  constructor(private readonly getConfig: () => DingTalkModuleConfig | undefined) {}

  available(): boolean {
    return dingTalkRobotReady(this.getConfig());
  }

  async send(staffId: string, n: OutboundNotification): Promise<DeliveryOutcome> {
    return this.sendText(staffId, `**${n.title}**\n\n${n.body}`);
  }

  async sendText(staffId: string, text: string): Promise<DeliveryOutcome> {
    const cfg = this.getConfig();
    if (!cfg || !dingTalkRobotReady(cfg)) return { ok: false, error: "钉钉机器人未配置" };
    try {
      const token = await getAccessToken(cfg.appKey, cfg.appSecret);
      await sendSingleMessage(token, {
        robotCode: cfg.robotCode ?? "",
        userIds: [staffId],
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({
          title: text.split("\n")[0]?.slice(0, 64) || "donger 通知",
          text,
        }),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: clipError(String((e as Error).message)) };
    }
  }
}
