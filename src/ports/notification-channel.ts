import type { OutboundChannelId } from "../domain/notification.js";

/** 站外投递载荷（内容已经过内核 redactSecrets 脱敏与截断） */
export interface OutboundNotification {
  /** 关联站内信行 id（webhook 幂等头 X-Donger-Notification-Id 用） */
  id: string;
  event: string;
  severity: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface DeliveryOutcome {
  ok: boolean;
  /** 失败原因摘要；禁止包含响应体原文（防内网数据回读）与敏感头 */
  error?: string;
}

export interface OutboundSendOpts {
  /** webhook 每地址签名密钥（HMAC-SHA256，extra 机密内） */
  secret?: string;
  /** webhook 用户自定义请求头 */
  headers?: Record<string, string>;
}

/**
 * 站外通知通道适配器（spec 2026-09-28-notification-module-design §4.3）。
 * 无状态：配置由构造注入；缺配置 available()=false → 内核记 skipped 不报错。
 */
export interface NotificationChannelAdapter {
  readonly id: OutboundChannelId;
  available(): boolean;
  send(address: string, n: OutboundNotification, opts?: OutboundSendOpts): Promise<DeliveryOutcome>;
  /** 向任意地址发纯文本（钉钉验证码等控制面消息；通道不支持则不实现） */
  sendText?(address: string, text: string): Promise<DeliveryOutcome>;
}

/** 错误摘要截断：网络错误信息可能内嵌 URL/响应片段，禁止原样外泄 */
export function clipError(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
