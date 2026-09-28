import { redactSecrets } from "../domain/audit.js";
import {
  type InAppNotification,
  isMandatoryGroup,
  isNotificationEvent,
  NOTIFICATION_EVENT_CATALOG,
  type NotificationEventGroup,
  type NotificationIntent,
  type NotificationPrefsEntry,
  OUTBOUND_CHANNELS,
  type OutboundChannelId,
  VERIFY_CODE_MAX_ATTEMPTS,
  VERIFY_CODE_TTL_MS,
} from "../domain/notification.js";
import type {
  NotificationChannelAdapter,
  OutboundNotification,
} from "../ports/notification-channel.js";
import type {
  NotificationDelivery,
  NotificationListResult,
  NotificationStore,
} from "../ports/notification-store.js";

export interface NotificationServiceDeps {
  store: NotificationStore;
  /** 单用户未读上限：超出后丢弃新通知（防风暴/刷爆）；已读恢复后自动放行 */
  maxUnreadPerUser?: number;
  /** 站外通道适配器（M2：dingtalk/webhook）；空=仅站内信 */
  adapters?: NotificationChannelAdapter[];
  /** 用户外部身份读取（钉钉 staffId 优先取钉钉登录身份） */
  getIdentities?: (userId: string) => Promise<Array<{ provider: string; externalId: string }>>;
  /** 站外投递失败重试退避（默认 2s/8s；测试注入 [0,0] 提速） */
  retryDelaysMs?: number[];
}

interface DingTalkVerifyPending {
  staffId: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

const WEBHOOK_RATE_LIMIT = 10;
const WEBHOOK_RATE_WINDOW_MS = 60_000;
const DINGTALK_VERIFY_RATE_LIMIT = 3;
const DINGTALK_VERIFY_RATE_WINDOW_MS = 3_600_000;
/** 站外投递失败重试：上限 2 次，退避 2s/8s（进程内；重启丢弃未决重试可接受） */
const RETRY_DELAYS_MS = [2_000, 8_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 通知内核（spec 2026-09-28-notification-module-design §3）：全系统会话外通知的唯一发出点。
 *
 * 流程：事件目录校验（fail-closed）→ 脱敏 → 收件人展开 → 路由合成（强制站内信 ∪ 用户偏好）
 * → 未读上限频控 → 站内信落库（dedupeKey 幂等）→ 站外通道异步分发（fire-and-forget，
 * 不阻塞事件源；逐通道独立投递与日志）。
 */
export class NotificationService {
  private readonly maxUnread: number;
  private readonly adapters: NotificationChannelAdapter[];
  private readonly retryDelaysMs: number[];
  /** 验证码 pending（内存态；重启丢失=用户重新申请，可接受） */
  private readonly dingTalkVerifyPending = new Map<string, DingTalkVerifyPending>();
  private readonly webhookHits = new Map<string, number[]>();
  private readonly verifyHits = new Map<string, number[]>();

  constructor(private readonly deps: NotificationServiceDeps) {
    this.maxUnread = deps.maxUnreadPerUser ?? 500;
    this.adapters = deps.adapters ?? [];
    this.retryDelaysMs = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async notify(intent: NotificationIntent): Promise<void> {
    // fail-closed：未登记事件直接拒绝（编程错误，宁可炸在发出方也不静默扩散）
    if (!isNotificationEvent(intent.event)) {
      throw new Error(`未登记的通知事件: ${String(intent.event)}`);
    }
    const spec = NOTIFICATION_EVENT_CATALOG[intent.event];
    const severity = intent.severity ?? spec.severity;
    // 内容脱敏 + 截断：通知不是审计载体，禁止携带凭证明文出站
    const title = redactSecrets(intent.title).slice(0, 200);
    const body = redactSecrets(intent.body).slice(0, 1000);
    const userIds = [
      ...new Set(intent.recipients.filter((r) => r.kind === "user").map((r) => r.userId)),
    ];
    const inappIds = new Map<string, string>();
    for (const userId of userIds) {
      if (!userId || !(await this.enabledFor(userId, spec.group, spec.mandatoryInapp))) continue;
      const unread = await this.deps.store.unreadCount(userId);
      if (unread >= this.maxUnread) {
        console.warn(
          `[notification] 用户 ${userId} 未读已达上限 ${this.maxUnread}，丢弃事件 ${intent.event}`,
        );
        continue;
      }
      const row: InAppNotification = {
        id: crypto.randomUUID(),
        userId,
        event: intent.event,
        severity,
        title,
        body,
        link: intent.link,
        dedupeKey: intent.dedupeKey,
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.insertInApp(row);
      inappIds.set(userId, row.id);
    }
    // 站外分发与站内解耦：站内被关/去重/限流不影响站外（各自偏好独立），且不阻塞事件源
    if (this.adapters.length > 0 && userIds.length > 0) {
      void this.dispatchOutbound(
        { ...intent, title, body, severity },
        spec.group,
        userIds,
        inappIds,
      );
    }
  }

  /** 路由合成：强制站内信 > 用户偏好 > 默认开（spec §4.4）；站外通道一律 opt-in */
  private async enabledFor(
    userId: string,
    group: NotificationEventGroup,
    mandatoryInapp: boolean,
  ): Promise<boolean> {
    if (mandatoryInapp) return true;
    const prefs = await this.deps.store.getPrefs(userId);
    const pref = prefs.find((p) => p.eventGroup === group && p.channel === "inapp");
    return pref ? pref.enabled : true;
  }

  // ===== 站外分发（M2）=====

  private async dispatchOutbound(
    intent: NotificationIntent,
    group: NotificationEventGroup,
    userIds: string[],
    inappIds: Map<string, string>,
  ): Promise<void> {
    for (const userId of userIds) {
      const prefs = await this.deps.store.getPrefs(userId);
      for (const channelId of OUTBOUND_CHANNELS) {
        const adapter = this.adapters.find((a) => a.id === channelId);
        const enabled = prefs.some(
          (p) => p.eventGroup === group && p.channel === channelId && p.enabled,
        );
        if (!enabled || !adapter) continue;
        if (!adapter.available()) {
          await this.recordDelivery(
            userId,
            channelId,
            intent,
            inappIds,
            1,
            "skipped",
            "通道未配置",
          );
          continue;
        }
        const resolved = await this.resolveOutboundAddress(userId, channelId);
        if (!resolved) {
          await this.recordDelivery(
            userId,
            channelId,
            intent,
            inappIds,
            1,
            "skipped",
            "未绑定投递地址",
          );
          continue;
        }
        if (channelId === "webhook" && !this.allowWebhookHit(userId)) {
          await this.recordDelivery(
            userId,
            channelId,
            intent,
            inappIds,
            1,
            "skipped",
            "触发频控（10 次/分钟）",
          );
          continue;
        }
        await this.deliverWithRetry(adapter, resolved, intent, userId, inappIds);
      }
    }
  }

  private async deliverWithRetry(
    adapter: NotificationChannelAdapter,
    resolved: { address: string; extra?: Record<string, unknown> },
    intent: NotificationIntent,
    userId: string,
    inappIds: Map<string, string>,
  ): Promise<void> {
    const payload: OutboundNotification = {
      id: inappIds.get(userId) ?? crypto.randomUUID(),
      event: intent.event,
      severity: intent.severity ?? "info",
      title: intent.title,
      body: intent.body,
      ...(intent.data ? { data: intent.data } : {}),
    };
    const sendOpts = {
      secret: typeof resolved.extra?.secret === "string" ? resolved.extra.secret : undefined,
      headers:
        resolved.extra?.headers && typeof resolved.extra.headers === "object"
          ? (resolved.extra.headers as Record<string, string>)
          : undefined,
    };
    let outcome: { ok: boolean; error?: string } = { ok: false, error: "未投递" };
    let attempts = 0;
    for (let i = 0; i <= this.retryDelaysMs.length; i++) {
      if (i > 0) await sleep(this.retryDelaysMs[i - 1] ?? 0);
      attempts = i + 1;
      outcome = await adapter.send(resolved.address, payload, sendOpts);
      if (outcome.ok) break;
    }
    await this.recordDelivery(
      userId,
      adapter.id,
      intent,
      inappIds,
      attempts,
      outcome.ok ? "ok" : "failed",
      outcome.error,
    );
  }

  private async recordDelivery(
    userId: string,
    channel: OutboundChannelId,
    intent: NotificationIntent,
    inappIds: Map<string, string>,
    attempts: number,
    status: NotificationDelivery["status"],
    error?: string,
  ): Promise<void> {
    const d: NotificationDelivery = {
      id: crypto.randomUUID(),
      notificationId: inappIds.get(userId),
      channel,
      event: intent.event,
      title: intent.title,
      status,
      ...(error ? { error } : {}),
      attempts,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.deps.store.insertDelivery(d);
    } catch (e) {
      console.error("[notification] 投递日志写入失败", e);
    }
  }

  /** 投递地址解析：钉钉登录身份 externalId 优先，回落已验证的手填地址（spec §4.2） */
  private async resolveOutboundAddress(
    userId: string,
    channel: OutboundChannelId,
  ): Promise<{ address: string; extra?: Record<string, unknown> } | undefined> {
    if (channel === "dingtalk") {
      const identities = (await this.deps.getIdentities?.(userId)) ?? [];
      const dt = identities.find((i) => i.provider === "dingtalk");
      if (dt?.externalId) return { address: dt.externalId };
    }
    const row = await this.deps.store.getAddress(userId, channel);
    if (!row) return undefined;
    if (channel === "dingtalk" && !row.verifiedAt) return undefined;
    return { address: row.address, extra: row.extra };
  }

  private allowWebhookHit(userId: string): boolean {
    const now = Date.now();
    const hits = (this.webhookHits.get(userId) ?? []).filter(
      (t) => now - t < WEBHOOK_RATE_WINDOW_MS,
    );
    if (hits.length >= WEBHOOK_RATE_LIMIT) {
      this.webhookHits.set(userId, hits);
      return false;
    }
    hits.push(now);
    this.webhookHits.set(userId, hits);
    return true;
  }

  // ===== 钉钉地址验证码闭环（spec 决策⑧）=====

  async requestDingTalkVerify(
    userId: string,
    staffId: string,
  ): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    if (
      !this.rateHit(
        this.verifyHits,
        userId,
        DINGTALK_VERIFY_RATE_LIMIT,
        DINGTALK_VERIFY_RATE_WINDOW_MS,
      )
    ) {
      return { ok: false, error: "验证请求过于频繁，请稍后再试", status: 429 };
    }
    // 防重复认领：他人已验证同一 staffId 时拒绝（防骚扰+防冒绑）
    const owners = await this.deps.store.findAddressOwners("dingtalk", staffId);
    if (owners.some((o) => o !== userId)) {
      return { ok: false, error: "该钉钉账号已被其他用户绑定", status: 409 };
    }
    const adapter = this.adapters.find((a) => a.id === "dingtalk");
    if (!adapter?.available() || !adapter.sendText) {
      return { ok: false, error: "钉钉机器人未配置，无法发送验证消息", status: 503 };
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const sent = await adapter.sendText(
      staffId,
      `donger 通知地址验证码：${code}（10 分钟内有效）。\n若非本人操作请忽略本消息。`,
    );
    if (!sent.ok) {
      this.dingTalkVerifyPending.delete(userId);
      return { ok: false, error: `验证消息发送失败：${sent.error ?? "未知错误"}`, status: 502 };
    }
    this.dingTalkVerifyPending.set(userId, {
      staffId,
      code,
      expiresAt: Date.now() + VERIFY_CODE_TTL_MS,
      attempts: 0,
    });
    return { ok: true };
  }

  async confirmDingTalkVerify(
    userId: string,
    code: string,
  ): Promise<{ ok: true; staffId: string } | { ok: false; error: string; status: number }> {
    const pending = this.dingTalkVerifyPending.get(userId);
    if (!pending) return { ok: false, error: "请先获取验证码", status: 400 };
    if (Date.now() > pending.expiresAt) {
      this.dingTalkVerifyPending.delete(userId);
      return { ok: false, error: "验证码已过期，请重新获取", status: 400 };
    }
    if (pending.attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
      this.dingTalkVerifyPending.delete(userId);
      return { ok: false, error: "尝试次数过多，请重新获取验证码", status: 429 };
    }
    if (pending.code !== code) {
      pending.attempts += 1;
      return { ok: false, error: "验证码不正确", status: 400 };
    }
    this.dingTalkVerifyPending.delete(userId);
    await this.deps.store.putAddress({
      userId,
      channel: "dingtalk",
      address: pending.staffId,
      verifiedAt: new Date().toISOString(),
    });
    return { ok: true, staffId: pending.staffId };
  }

  private rateHit(
    map: Map<string, number[]>,
    key: string,
    limit: number,
    windowMs: number,
  ): boolean {
    const now = Date.now();
    const hits = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      map.set(key, hits);
      return false;
    }
    hits.push(now);
    map.set(key, hits);
    return true;
  }

  // ===== 测试发送 / 通道状态 / 地址簿透传 =====

  /**
   * 保存 webhook 地址（spec §7.2/§7.5）：SSRF 深校验（硬拒）→ 存活探测（软性，结果随响应
   * 返回但不回显响应体）→ 自动生成签名密钥（已有地址保留原密钥，防第三方验证方失效）。
   */
  async saveWebhookAddress(
    userId: string,
    input: { url: string; headers?: Record<string, string> },
    opts: { allowPrivateNet?: boolean },
  ): Promise<
    | { ok: true; probe: { reachable: boolean; detail?: string } }
    | { ok: false; error: string; status: number }
  > {
    const { validateTriggerHttpUrlDeep } = await import("../domain/net-target.js");
    const validated = await validateTriggerHttpUrlDeep(input.url, opts.allowPrivateNet === true);
    if (!validated) {
      return {
        ok: false,
        error: "仅支持公网目标（内网/环回/元数据地址被安全守卫拒绝）",
        status: 400,
      };
    }
    const existing = await this.deps.store.getAddress(userId, "webhook");
    const prevSecret =
      typeof existing?.extra?.secret === "string" ? existing.extra.secret : undefined;
    const secret =
      prevSecret ??
      crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const extra: Record<string, unknown> = { secret };
    if (input.headers && Object.keys(input.headers).length > 0) extra.headers = input.headers;
    // 存活探测：结果只到 ok/error 摘要粒度，不回显响应内容
    const adapter = this.adapters.find((a) => a.id === "webhook");
    const probe = adapter
      ? await adapter.send(
          validated,
          {
            id: crypto.randomUUID(),
            event: "system.announcement",
            severity: "info",
            title: "donger webhook 地址验证",
            body: "这是一条保存时的连通性验证消息。",
          },
          { secret, headers: input.headers },
        )
      : { ok: false, error: "通道未装配" };
    await this.deps.store.putAddress({
      userId,
      channel: "webhook",
      address: input.url,
      extra,
      verifiedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      probe: { reachable: probe.ok, ...(probe.error ? { detail: probe.error } : {}) },
    };
  }

  hasDingTalkVerifyPending(userId: string): boolean {
    return this.dingTalkVerifyPending.has(userId);
  }

  /** 向已配置地址发一条合成通知（webhook 探活、钉钉连通性自检） */
  async testSend(
    userId: string,
    channel: OutboundChannelId,
  ): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapters.find((a) => a.id === channel);
    if (!adapter?.available()) return { ok: false, error: "通道未配置" };
    const resolved = await this.resolveOutboundAddress(userId, channel);
    if (!resolved) return { ok: false, error: "未绑定投递地址" };
    const outcome = await adapter.send(resolved.address, {
      id: crypto.randomUUID(),
      event: "system.announcement",
      severity: "info",
      title: "donger 测试通知",
      body: "这是一条测试通知，收到即代表通道配置正确。",
    });
    return outcome;
  }

  /** 通道可用性（管理端状态展示） */
  channelStatus(): Record<OutboundChannelId, boolean> {
    const status = {} as Record<OutboundChannelId, boolean>;
    for (const id of OUTBOUND_CHANNELS) {
      status[id] = this.adapters.find((a) => a.id === id)?.available() ?? false;
    }
    return status;
  }

  async getAddress(userId: string, channel: OutboundChannelId) {
    return this.deps.store.getAddress(userId, channel);
  }

  async deleteAddress(userId: string, channel: OutboundChannelId): Promise<void> {
    await this.deps.store.deleteAddress(userId, channel);
    this.dingTalkVerifyPending.delete(userId);
  }

  listDeliveries(limit: number) {
    return this.deps.store.listDeliveries(limit);
  }

  // ===== 站内信读侧 API 透传（属主过滤在 store SQL 条件内）=====

  list(
    userId: string,
    opts: { limit: number; offset: number; unreadOnly?: boolean },
  ): Promise<NotificationListResult> {
    return this.deps.store.list(userId, opts);
  }

  unreadCount(userId: string): Promise<number> {
    return this.deps.store.unreadCount(userId);
  }

  markRead(userId: string, id: string): Promise<boolean> {
    return this.deps.store.markRead(userId, id);
  }

  markAllRead(userId: string): Promise<number> {
    return this.deps.store.markAllRead(userId);
  }

  getPrefs(userId: string): Promise<NotificationPrefsEntry[]> {
    return this.deps.store.getPrefs(userId);
  }

  /** 偏好写入：强制组仅锁站内信关闭（站外通道自由开关），返回 false 表示被拒 */
  async setPref(userId: string, entry: NotificationPrefsEntry): Promise<boolean> {
    if (!entry.enabled && entry.channel === "inapp" && isMandatoryGroup(entry.eventGroup)) {
      return false;
    }
    await this.deps.store.setPref(userId, entry);
    return true;
  }
}
