import { createHmac } from "node:crypto";
import { validateTriggerHttpUrlDeep } from "../domain/net-target.js";
import {
  clipError,
  type DeliveryOutcome,
  type NotificationChannelAdapter,
  type OutboundNotification,
  type OutboundSendOpts,
} from "../ports/notification-channel.js";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * webhook 出站适配器（spec §7 安全红线）：
 * - URL 保存与每次发送都过 validateTriggerHttpUrlDeep（DNS 解析后复判内网/环回/元数据地址）；
 * - 手动跟随重定向并对每跳重新校验（防 302 跳内网绕过）；
 * - 响应体只丢弃不回显（防内网数据回读），失败原因仅 HTTP 状态码；
 * - 签名：X-Donger-Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)，配
 *   X-Donger-Timestamp / X-Donger-Notification-Id（幂等）。
 */
export class WebhookNotificationAdapter implements NotificationChannelAdapter {
  readonly id = "webhook" as const;

  constructor(
    private readonly opts: {
      /** 与触发器共用同一开关（TRIGGER_ALLOW_PRIVATE_NET） */
      allowPrivateNet?: boolean;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  available(): boolean {
    return true;
  }

  async send(
    url: string,
    n: OutboundNotification,
    sendOpts?: OutboundSendOpts,
  ): Promise<DeliveryOutcome> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const body = JSON.stringify({
      id: n.id,
      event: n.event,
      severity: n.severity,
      title: n.title,
      body: n.body,
      ...(n.data ? { data: n.data } : {}),
      timestamp: new Date().toISOString(),
    });
    try {
      const outcome = await this.postWithRedirects(fetchImpl, url, body, n, sendOpts);
      return outcome;
    } catch (e) {
      return { ok: false, error: clipError(String((e as Error).message)) };
    }
  }

  private async postWithRedirects(
    fetchImpl: typeof fetch,
    startUrl: string,
    body: string,
    n: OutboundNotification,
    sendOpts?: OutboundSendOpts,
  ): Promise<DeliveryOutcome> {
    let current = startUrl;
    const currentBody = body;
    let method: "POST" | "GET" = "POST";
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 每跳都过 SSRF 深校验（含 DNS 解析后复判），拒绝即终止且不回显原因细节
      const validated = await validateTriggerHttpUrlDeep(
        current,
        this.opts.allowPrivateNet === true,
      );
      if (!validated) return { ok: false, error: "目标被安全守卫拒绝（仅支持公网目标）" };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Donger-Notification-Id": n.id,
        "X-Donger-Timestamp": new Date().toISOString(),
        ...(sendOpts?.headers ?? {}),
      };
      if (sendOpts?.secret && method === "POST") {
        headers["X-Donger-Signature"] = createHmac("sha256", sendOpts.secret)
          .update(`${headers["X-Donger-Timestamp"]}.${currentBody}`)
          .digest("hex");
      }
      const res = await fetchImpl(validated, {
        method,
        headers,
        body: method === "POST" ? currentBody : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        // 响应体丢弃不回显（防内网数据回读）
        await res.arrayBuffer().catch(() => undefined);
        return { ok: true };
      }
      if (RETRYABLE_STATUS.has(res.status) && hop < MAX_REDIRECTS) {
        const location = res.headers.get("location");
        await res.arrayBuffer().catch(() => undefined);
        if (location) {
          const next = new URL(location, validated).toString();
          // 303（及 301/302 的浏览器语义）转 GET 丢 body；307/308 保持 POST 原样
          method = res.status === 307 || res.status === 308 ? "POST" : "GET";
          current = next;
          continue;
        }
      }
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: false, error: `重定向超过 ${MAX_REDIRECTS} 跳` };
  }
}
