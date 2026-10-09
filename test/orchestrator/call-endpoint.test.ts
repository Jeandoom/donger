import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../../src/domain/event.js";
import { CallEndpoint } from "../../src/orchestrator/call-endpoint.js";

const logger = pino({ level: "silent" });

function setup() {
  const dispatcher = { fire: vi.fn().mockResolvedValue(undefined) };
  const eventStore = {
    findByCallPath: vi.fn(),
  };
  const endpoint = new CallEndpoint({
    eventStore: eventStore as never,
    dispatcher: dispatcher as never,
    logger,
  });
  return { endpoint, eventStore, dispatcher };
}

const callEvent = (over: Partial<Event> = {}): Event => ({
  id: "e1",
  ownerId: "u1",
  name: "回调",
  type: "call",
  call: {
    path: "/hooks/abcdef01",
    methods: ["GET", "POST"],
    responseStatus: 200,
    responseBody: "ok",
    matcher: { kind: "always" },
  },
  createdAt: "now",
  updatedAt: "now",
  ...over,
});

describe("CallEndpoint", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("POST {query,data} 归一为上下文 JSON 并触发（fire 含 query/data）", async () => {
    s.eventStore.findByCallPath.mockResolvedValue(callEvent());
    const res = await s.endpoint.handle({
      method: "POST",
      url: "/hooks/abcdef01",
      headers: {},
      body: JSON.stringify({ query: "hello", data: { k: 1 } }),
    });
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(s.dispatcher.fire).toHaveBeenCalledTimes(1);
    const [eventId, ctx, source] = s.dispatcher.fire.mock.calls[0] as [
      string,
      { payload: string; query?: string; data?: Record<string, unknown> },
      string,
    ];
    expect(eventId).toBe("e1");
    expect(source).toBe("call");
    expect(ctx.query).toBe("hello");
    expect(ctx.data).toEqual({ k: 1 });
    const payload = JSON.parse(ctx.payload) as Record<string, unknown>;
    expect(payload.query).toBe("hello");
    expect(payload.firedAt).toBeTruthy();
    expect(payload.path).toBe("/hooks/abcdef01");
  });

  it("GET 查询串归一：query 参数之外收进 data", async () => {
    s.eventStore.findByCallPath.mockResolvedValue(callEvent());
    await s.endpoint.handle({
      method: "GET",
      url: "/hooks/abcdef01?query=ping&env=prod&n=3",
      headers: {},
      body: "",
    });
    const [, ctx] = s.dispatcher.fire.mock.calls[0] as [
      string,
      { query: string; data: Record<string, unknown> },
    ];
    expect(ctx.query).toBe("ping");
    expect(ctx.data).toEqual({ env: "prod", n: 3 });
  });

  it("非 JSON body 宽容降级：整体作为 query（外部系统最简接入）", async () => {
    s.eventStore.findByCallPath.mockResolvedValue(callEvent());
    await s.endpoint.handle({
      method: "POST",
      url: "/hooks/abcdef01",
      headers: {},
      body: "plain text payload",
    });
    const [, ctx] = s.dispatcher.fire.mock.calls[0] as [
      string,
      { query: string; data: Record<string, unknown> },
    ];
    expect(ctx.query).toBe("plain text payload");
    expect(ctx.data).toEqual({});
  });

  it("matcher 未命中不触发（静默，返回配置响应）", async () => {
    s.eventStore.findByCallPath.mockResolvedValue(
      callEvent({
        call: {
          path: "/hooks/abcdef01",
          methods: ["GET", "POST"],
          responseStatus: 200,
          responseBody: "ok",
          matcher: { kind: "bodyContains", keyword: "secret" },
        },
      }),
    );
    const res = await s.endpoint.handle({
      method: "POST",
      url: "/hooks/abcdef01",
      headers: {},
      body: JSON.stringify({ query: "no-match", data: {} }),
    });
    expect(res.status).toBe(200);
    expect(s.dispatcher.fire).not.toHaveBeenCalled();
  });

  it("未知路径 404；未声明方法 405", async () => {
    s.eventStore.findByCallPath.mockResolvedValue(undefined);
    expect(
      (await s.endpoint.handle({ method: "POST", url: "/hooks/none", headers: {}, body: "" }))
        .status,
    ).toBe(404);

    s.eventStore.findByCallPath.mockResolvedValue(
      callEvent({
        call: {
          path: "/hooks/abcdef01",
          methods: ["POST"],
          responseStatus: 200,
          responseBody: "ok",
          matcher: { kind: "always" },
        },
      }),
    );
    expect(
      (await s.endpoint.handle({ method: "GET", url: "/hooks/abcdef01", headers: {}, body: "" }))
        .status,
    ).toBe(405);
  });
});
