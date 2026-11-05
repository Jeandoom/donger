import type {
  ChannelAdapter,
  ChannelTestResult,
} from "../ports/channel-adapter.js";

/**
 * Webhook 渠道适配器（2026-11-05 统一通知设计）：
 * - 出站推送：POST 用户自登记 URL（HMAC 签名 + 幂等头；SSRF 守卫/重定向复判在
 *   WebhookNotificationAdapter 内）——无全局连接配置，按用户地址簿（configSource=address_book）
 * - 无回原/无入站（纯出站 fan-out，无线程语义）
 * 渠道连接卡片语义：available 恒 true（无全局门）；「测试」无全局连接可探，
 * 连通性验证在地址簿保存时探活（saveWebhookAddress probe）。
 */
export class WebhookChannelAdapter implements ChannelAdapter {
  readonly id = "webhook";
  readonly displayName = "Webhook";
  readonly description = "用户自登记 URL 的出站推送（HMAC 签名；每用户独立地址）";
  readonly capabilities = {
    outboundPush: true,
    replyToSource: false,
    inbound: null,
  };
  readonly configSource = "address_book" as const;
  readonly configHint = "按用户地址簿配置（通知中心/渠道连接内登记 URL）";

  available(): boolean {
    return true;
  }

  async testConnection(): Promise<ChannelTestResult> {
    return {
      ok: true,
      detail: "按用户地址簿配置：连通性在保存地址时探活（无全局连接可测）",
    };
  }
}
