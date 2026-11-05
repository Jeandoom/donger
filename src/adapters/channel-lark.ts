import type { PlatformMessageEnvelope } from "../domain/event-payloads.js";
import type { ReplyAnchor } from "../domain/event.js";
import type {
  ChannelAdapter,
  ChannelDelivery,
  ChannelReplyMessage,
  ChannelStatusSnapshot,
  ChannelTestResult,
} from "../ports/channel-adapter.js";

/**
 * 飞书渠道适配器（2026-11-05 统一通知设计 M4 样板）：
 * 验证「新平台接入四步」——①实现 ChannelAdapter ②注册表注册 ③入站锚点声明
 * （normalizeWebhook → 统一信封+replyAnchor）④webhook 端点接线（/api/webhooks/lark）。
 *
 * - 出站推送：im/v1/messages（receive_id_type=open_id，收件地址=用户 open_id 地址簿）
 * - 回原投递：im/v1/messages/{message_id}/reply（回触发消息线程）
 * - 入站：事件订阅 webhook（im.message.received_v1；verification token 校验）
 * 配置真源=channel_connections 自持（拍板 D6：新平台不自持授权页无此面）。
 */

export interface LarkConfig {
  appId: string;
  appSecret: string;
  /** 事件订阅 verification token（webhook 校验；可空=跳过校验仅本地调试） */
  verificationToken?: string;
}

const LARK_BASE = "https://open.feishu.cn";

export class LarkChannelAdapter implements ChannelAdapter {
  readonly id = "lark";
  readonly displayName = "飞书";
  readonly description = "机器人消息（open_id 单聊推送 / 消息线程回原 / 事件订阅入站）";
  readonly capabilities = {
    outboundPush: true,
    replyToSource: true,
    inbound: "webhook" as const,
  };
  readonly configSource = "connection" as const;
  readonly configHint = "自持配置（渠道连接内登记 appId/appSecret）";

  constructor(
    private readonly getConfig: () => LarkConfig | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): boolean {
    const cfg = this.getConfig();
    return !!cfg?.appId && !!cfg?.appSecret;
  }

  /** tenant_access_token（进程内缓存；过期前 60s 视为失效） */
  private token?: { value: string; expiresAt: number };
  private async tenantToken(cfg: LarkConfig): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`飞书 token 获取失败 (${body.code}): ${body.msg ?? "unknown"}`);
    }
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + (body.expire ?? 7200) * 1000,
    };
    return this.token.value;
  }

  async testConnection(): Promise<ChannelTestResult> {
    const cfg = this.getConfig();
    if (!cfg?.appId || !cfg?.appSecret) {
      return { ok: false, error: "飞书配置不完整（appId/appSecret）" };
    }
    try {
      const started = Date.now();
      await this.tenantToken(cfg);
      return { ok: true, detail: `tenant_access_token 获取成功（${Date.now() - started}ms）` };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }

  async send(address: string, title: string, body: string): Promise<ChannelDelivery> {
    const cfg = this.getConfig();
    if (!cfg) throw new Error("飞书未配置");
    const token = await this.tenantToken(cfg);
    const res = await this.fetchImpl(
      `${LARK_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          receive_id: address,
          msg_type: "text",
          content: JSON.stringify({ text: title ? `${title}\n${body}` : body }),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const out = (await res.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (out.code !== 0) {
      return { ok: false, error: `飞书消息发送失败 (${out.code}): ${out.msg ?? "unknown"}` };
    }
    return { ok: true, receipt: { messageId: out.data?.message_id } };
  }

  async replyToSource(anchor: ReplyAnchor, message: ChannelReplyMessage): Promise<ChannelDelivery> {
    if (anchor.kind !== "chat" || !anchor.target.messageId) {
      throw new Error(`飞书回原锚点形态不符: kind=${anchor.kind}`);
    }
    const cfg = this.getConfig();
    if (!cfg) throw new Error("飞书未配置");
    const token = await this.tenantToken(cfg);
    const res = await this.fetchImpl(
      `${LARK_BASE}/open-apis/im/v1/messages/${encodeURIComponent(anchor.target.messageId)}/reply`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text: message.body }),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const out = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    };
    if (out.code !== 0) {
      return { ok: false, error: `飞书回复失败 (${out.code}): ${out.msg ?? "unknown"}` };
    }
    return {
      ok: true,
      receipt: { messageId: out.data?.message_id, chatId: anchor.target.chatId },
    };
  }

  /**
   * 入站 webhook 归一：im.message.received_v1 → 统一信封（锚点=message 线程，
   * 通知轮回原即回复该消息）；verification token 校验在 web-channel HTTP 面（challenge 应答）。
   */
  normalizeWebhook(payload: unknown): PlatformMessageEnvelope | null {
    const body = payload as {
      header?: { event_type?: string; token?: string };
      event?: {
        message?: {
          message_id?: string;
          chat_id?: string;
          message_type?: string;
          content?: string;
          create_time?: string;
        };
        sender?: { sender_id?: { open_id?: string } };
      };
    };
    if (body.header?.event_type !== "im.message.received_v1") return null;
    const msg = body.event?.message;
    const senderId = body.event?.sender?.sender_id?.open_id ?? "";
    if (!msg?.message_id || !msg.chat_id) return null;
    // text 类型 content 是 JSON 字符串 {"text":"..."}；其他类型（卡片/富文本）原文透传
    let text = msg.content ?? "";
    if (msg.message_type === "text") {
      try {
        text = (JSON.parse(text) as { text?: string }).text ?? text;
      } catch {
        // 保持原文
      }
    }
    return {
      platform: "lark",
      topic: "im.message",
      eventId: msg.message_id,
      occurredAt: msg.create_time
        ? new Date(Number(msg.create_time)).toISOString()
        : new Date().toISOString(),
      sender: { id: senderId, name: "" },
      source: { chatId: msg.chat_id },
      text,
      raw: { messageType: msg.message_type },
      replyAnchor: {
        platform: "lark",
        kind: "chat",
        target: { messageId: msg.message_id, chatId: msg.chat_id },
      },
    };
  }

  /** webhook 校验（verification token；配置为空=跳过仅调试） */
  verifyWebhook(payload: { header?: { token?: string } }): boolean {
    const expected = this.getConfig()?.verificationToken;
    if (!expected) return true;
    return payload.header?.token === expected;
  }

  status(): ChannelStatusSnapshot {
    const cfg = this.getConfig();
    return {
      inbound: {
        mode: "webhook",
        connected: !!cfg?.appId && !!cfg?.appSecret,
        detail: "端点 /api/webhooks/lark（飞书事件订阅登记）",
      },
    };
  }
}
