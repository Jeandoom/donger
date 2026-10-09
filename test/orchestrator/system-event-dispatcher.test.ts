import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../../src/domain/event.js";
import { SystemEventDispatcher } from "../../src/orchestrator/system-event-dispatcher.js";

const logger = pino({ level: "silent" });

function setup() {
  const dispatcher = { fire: vi.fn().mockResolvedValue(undefined) };
  const eventStore = { listAll: vi.fn().mockResolvedValue([]) };
  const d = new SystemEventDispatcher({
    eventStore: eventStore as never,
    dispatcher: dispatcher as never,
    logger,
  });
  return { d, eventStore, dispatcher };
}

const systemEvent = (over: Partial<Event> = {}): Event => ({
  id: "e1",
  ownerId: "u1",
  name: "反馈事件",
  type: "system",
  system: { name: "feedback.created", matcher: { kind: "always" } },
  createdAt: "now",
  updatedAt: "now",
  ...over,
});

describe("SystemEventDispatcher", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("按事件名命中订阅事件并 fire（payload 原样传递）", async () => {
    s.eventStore.listAll.mockResolvedValue([systemEvent()]);
    await s.d.dispatch("feedback.created", '{"event":"feedback.created"}');
    expect(s.dispatcher.fire).toHaveBeenCalledTimes(1);
    const [eventId, ctx, source] = s.dispatcher.fire.mock.calls[0] as [
      string,
      { payload: string },
      string,
    ];
    expect(eventId).toBe("e1");
    expect(source).toBe("system");
    expect(ctx.payload).toBe('{"event":"feedback.created"}');
  });

  it("matcher 未命中不触发；其它事件名不触发", async () => {
    s.eventStore.listAll.mockResolvedValue([
      systemEvent({
        system: { name: "feedback.created", matcher: { kind: "bodyContains", keyword: "urgent" } },
      }),
    ]);
    await s.d.dispatch("feedback.created", '{"content":"普通反馈"}');
    expect(s.dispatcher.fire).not.toHaveBeenCalled();

    s.dispatcher.fire.mockClear();
    s.eventStore.listAll.mockResolvedValue([systemEvent()]);
    await s.d.dispatch("kb.updated", "{}");
    expect(s.dispatcher.fire).not.toHaveBeenCalled();
  });
});
