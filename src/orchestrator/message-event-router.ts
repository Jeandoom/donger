import type { EventMessageConfig, FireContext } from "../domain/event.js";
import { evaluateMatcher } from "../domain/event-matcher.js";
import {
  buildPlatformMessagePayload,
  type PlatformMessageEnvelope,
} from "../domain/event-payloads.js";
import type { EventStore } from "../ports/event-store.js";

/**
 * 平台消息事件路由（spec 2026-10-27-platform-message-subscription-design §4.2 M1）：
 * 通道层（DingTalkChannel 群 @）归一出统一信封后进入此路由——
 * 1. 预判前置（D6）：listAll 过滤 type=message 且 platform/topic 命中的订阅，无订阅者
 *    直接回落（钉钉=对话语义；TB=M2 快速 200 空应答），firing 表与队列不被噪音灌满；
 * 2. 去重（D6）：按 platform:eventId 进程内窗口查重（10 分钟）——钉钉 60s 未 ACK 服务端
 *    重推、TB at-least-once 重试只跑一轮。跨进程重启的窗口重复属可接受边角（M2 如需
 *    严格可换 firing 表窗口查重）；
 * 3. filter 收窄（D4）：openConversationId/allowFrom 白名单——全被拒仍算消费（白名单外
 *    成员 @ 不透传对话，避免非订阅群成员拿到属主身份的聊天回复）；
 * 4. fire 上下文：payload=信封 JSON 原文（{{triggerOutput}}），data=信封对象（{{data}}），
 *    messageMeta 携带去重键；replyAnchor 在信封内随 run.context 持久化（通知轮消费）。
 */
export const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;

export interface MessageEventRouterDeps {
  eventStore: Pick<EventStore, "listAll">;
  dispatcher: { fire(eventId: string, ctx: FireContext, source: string): Promise<void> };
  logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

export interface MessageRouteOutcome {
  /** true=命中至少一个 message 订阅（含被 filter 拒绝——已消费，不回落对话） */
  consumed: boolean;
  /** 实际 fire 的订阅数（filter/matcher 命中） */
  fired: number;
}

/** filter 收窄（D4）：未配置=全放行；配置了=字段全命中才放行 */
export function matchesMessageFilter(
  filter: EventMessageConfig["filter"],
  envelope: PlatformMessageEnvelope,
): boolean {
  if (!filter) return true;
  if (
    filter.openConversationId &&
    envelope.source.openConversationId !== filter.openConversationId
  ) {
    return false;
  }
  if (filter.orgId && envelope.source.orgId !== filter.orgId) return false;
  if (filter.projectId && envelope.source.projectId !== filter.projectId) return false;
  if (filter.allowFrom && !filter.allowFrom.includes(envelope.sender.id)) return false;
  return true;
}

export class MessageEventRouter {
  private readonly seen = new Map<string, number>();

  constructor(private readonly deps: MessageEventRouterDeps) {}

  async route(envelope: PlatformMessageEnvelope): Promise<MessageRouteOutcome> {
    const events = (await this.deps.eventStore.listAll()).filter(
      (e) =>
        e.type === "message" &&
        e.message?.platform === envelope.platform &&
        e.message?.topic === envelope.topic,
    );
    if (events.length === 0) return { consumed: false, fired: 0 };

    const dedupKey = `${envelope.platform}:${envelope.eventId}`;
    if (this.seen.has(dedupKey)) {
      this.deps.logger?.warn({ dedupKey }, "message event: 窗口内重复推送，已去重丢弃");
      return { consumed: true, fired: 0 };
    }
    this.seen.set(dedupKey, Date.now());
    this.gcSeen();

    const payload = buildPlatformMessagePayload(envelope);
    let fired = 0;
    for (const ev of events) {
      const cfg = ev.message;
      if (!cfg) continue;
      if (!matchesMessageFilter(cfg.filter, envelope)) continue;
      if (cfg.matcher && !evaluateMatcher(cfg.matcher, { body: payload }).matched) continue;
      await this.deps.dispatcher.fire(
        ev.id,
        {
          payload,
          data: envelope as unknown as Record<string, unknown>,
          messageMeta: { eventId: envelope.eventId, platform: envelope.platform },
        },
        "message",
      );
      fired += 1;
    }
    this.deps.logger?.info(
      { platform: envelope.platform, topic: envelope.topic, eventId: envelope.eventId, fired },
      "message event routed",
    );
    return { consumed: true, fired };
  }

  private gcSeen(): void {
    const now = Date.now();
    for (const [k, ts] of this.seen) {
      if (now - ts > MESSAGE_DEDUP_TTL_MS) this.seen.delete(k);
    }
  }
}
