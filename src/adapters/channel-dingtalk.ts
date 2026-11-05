import type { DingTalkModuleConfig } from "../domain/module-config.js";
import { dingTalkRobotReady } from "../domain/module-config.js";
import type { DingTalkChannel } from "./dingtalk-channel.js";
import { getAccessToken } from "../util/dingtalk-api.js";
import type {
  ChannelAdapter,
  ChannelStatusSnapshot,
  ChannelTestResult,
} from "../ports/channel-adapter.js";

/**
 * 钉钉渠道适配器（2026-11-05 统一通知设计）：
 * - 出站推送：oToMessages 单聊（投递逻辑在 NotificationService 的 DingTalkNotificationAdapter，此处不重写）
 * - 回原投递：群机器人 groupMessages/send 回触发群（ DingTalkChannel.send）
 * - 入站：dingtalk-stream DWClient 长连接（群 @；建链在 DingTalkChannel.onMessage）
 * 配置真源=授权页 module_configs（D6 混合拍板：引用不搬迁，卡片展示引用关系）。
 */
export class DingTalkChannelAdapter implements ChannelAdapter {
  readonly id = "dingtalk";
  readonly displayName = "钉钉";
  readonly description = "群机器人（群 @ 触发 / 群内回原）+ 单聊主动推送（钉钉登录身份或 staffId 地址簿）";
  readonly capabilities = {
    outboundPush: true,
    replyToSource: true,
    inbound: "stream" as const,
  };
  readonly configSource = "module_configs" as const;
  readonly configHint = "引用授权页钉钉配置（appKey/appSecret/robotCode）";

  constructor(
    private readonly getConfig: () => DingTalkModuleConfig | undefined,
    /** 通道引用延迟解析（dtChannel 在 index 中晚于 registry 声明赋值） */
    private readonly getChannel: () => DingTalkChannel | undefined = () => undefined,
  ) {}

  available(): boolean {
    return dingTalkRobotReady(this.getConfig());
  }

  async testConnection(): Promise<ChannelTestResult> {
    const cfg = this.getConfig();
    if (!dingTalkRobotReady(cfg)) {
      return { ok: false, error: "钉钉配置不完整（appKey/appSecret/robotCode）" };
    }
    try {
      const started = Date.now();
      await getAccessToken(cfg!.appKey, cfg!.appSecret);
      return { ok: true, detail: `access token 获取成功（${Date.now() - started}ms）` };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }

  status(): ChannelStatusSnapshot {
    return {
      inbound: {
        mode: "stream",
        connected: this.getChannel()?.isRunning() ?? false,
        detail: this.getChannel()?.isRunning()
          ? "dingtalk-stream 长连接在线"
          : "长连接未建立（机器人未启用或配置缺失）",
      },
    };
  }
}
