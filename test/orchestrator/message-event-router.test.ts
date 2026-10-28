import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import type { PlatformMessageEnvelope } from "../../src/domain/event-payloads.js";
import type { EventInput } from "../../src/domain/event.js";
import { MessageEventRouter, matchesMessageFilter } from "../../src/orchestrator/message-event-router.js";

const logger = { info: vi.fn(), warn: vi.fn() };

function envelope(over: Partial<PlatformMessageEnvelope> = {}): PlatformMessageEnvelope {
  return {
    platform: "dingtalk",
    topic: "robot.group",
    eventId: "msg-1",
    occurredAt: "2026-10-28T00:00:00.000Z",
    sender: { id: "staff-1", name: "张三" },
    source: { openConversationId: "cid-group-1", conversationType: "2" },
    text: "@机器人 帮我查下库存",
    replyAnchor: { platform: "dingtalk", kind: "group", threadId: "cid-group-1" },
    ...over,
  };
}

async function setup(events: EventInput[]) {
  const db = new Database(":memory:");
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  for (const e of events) {
    await eventStore.create({ ...e, ownerId: "owner-1" });
  }
  const fire = vi.fn().mockResolvedValue(undefined);
  const router = new MessageEventRouter({ eventStore, dispatcher: { fire }, logger });
  return { router, fire };
}

function messageEvent(
  over: Partial<NonNullable<EventInput["message"]>> & { name?: string } = {},
): EventInput {
  return {
    name: "群消息订阅",
    type: "message",
    message: { platform: "dingtalk", topic: "robot.group", ...over },
  } as EventInput;
}

describe("MessageEventRouter", () => {
  it("无订阅 → 不消费（回落对话语义），不 fire", async () => {
    const { router, fire } = await setup([]);
    const r = await router.route(envelope());
    expect(r).toEqual({ consumed: false, fired: 0 });
    expect(fire).not.toHaveBeenCalled();
  });

  it("platform/topic 命中 → fire（payload=信封 JSON、data=信封对象、messageMeta 去重键、source=message）", async () => {
    const { router, fire } = await setup([messageEvent()]);
    const env = envelope();
    const r = await router.route(env);
    expect(r).toEqual({ consumed: true, fired: 1 });
    expect(fire).toHaveBeenCalledOnce();
    const [eventId, ctx, source] = fire.mock.calls[0] as [string, never, string];
    expect(eventId).toBeTruthy();
    expect(source).toBe("message");
    expect((ctx as { payload: string }).payload).toBe(JSON.stringify(env));
    expect(((ctx as { data: PlatformMessageEnvelope }).data.replyAnchor as { threadId: string }).threadId).toBe(
      "cid-group-1",
    );
    expect((ctx as { messageMeta: unknown }).messageMeta).toEqual({
      eventId: "msg-1",
      platform: "dingtalk",
    });
  });

  it("同 eventId 重复推送 → 去重丢弃（只跑一轮）", async () => {
    const { router, fire } = await setup([messageEvent()]);
    await router.route(envelope());
    const r = await router.route(envelope({ eventId: "msg-1" }));
    expect(r).toEqual({ consumed: true, fired: 0 });
    expect(fire).toHaveBeenCalledOnce();
  });

  it("openConversationId 不符 → 消费但不 fire（群隔离）", async () => {
    const { router, fire } = await setup([
      messageEvent({ filter: { openConversationId: "cid-other" } }),
    ]);
    const r = await router.route(envelope());
    expect(r).toEqual({ consumed: true, fired: 0 });
    expect(fire).not.toHaveBeenCalled();
  });

  it("allowFrom 白名单外成员 → 消费但不 fire（不透传对话）", async () => {
    const { router, fire } = await setup([messageEvent({ filter: { allowFrom: ["staff-9"] } })]);
    const r = await router.route(envelope());
    expect(r).toEqual({ consumed: true, fired: 0 });
    expect(fire).not.toHaveBeenCalled();
  });

  it("matcher 不命中 → 不 fire；多条订阅各自独立 fire", async () => {
    const { router, fire } = await setup([
      messageEvent({ matcher: { kind: "bodyContains", keyword: "库存" } }),
      messageEvent({ name: "转发群" }),
    ]);
    const r = await router.route(envelope({ text: "闲聊一句" }));
    expect(r).toEqual({ consumed: true, fired: 1 });
    expect(fire).toHaveBeenCalledOnce();
  });
});

describe("matchesMessageFilter", () => {
  it("未配置 filter=全放行；各字段与信封比对", () => {
    const env = envelope();
    expect(matchesMessageFilter(undefined, env)).toBe(true);
    expect(
      matchesMessageFilter({ openConversationId: "cid-group-1", allowFrom: ["staff-1"] }, env),
    ).toBe(true);
    expect(matchesMessageFilter({ allowFrom: ["staff-2"] }, env)).toBe(false);
    expect(matchesMessageFilter({ orgId: "org-1" }, env)).toBe(false);
  });
});
