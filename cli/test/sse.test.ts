import { describe, expect, it } from "vitest";
import { parseSSEBuffer } from "../src/sse.js";

describe("parseSSEBuffer", () => {
  it("解析单个完整事件", () => {
    const { events, rest } = parseSSEBuffer('event: text\ndata: {"type":"text","text":"你好"}\n\n');
    expect(events).toEqual([{ type: "text", text: "你好" }]);
    expect(rest).toBe("");
  });

  it("chunk 边界切割：半个事件留在 rest", () => {
    const first = parseSSEBuffer('event: text\ndata: {"type":"text","te');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('event: text\ndata: {"type":"text","te');

    const second = parseSSEBuffer(`${first.rest}xt":"hi"}\n\nevent: re`);
    expect(second.events).toEqual([{ type: "text", text: "hi" }]);
    expect(second.rest).toBe("event: re");
  });

  it("多事件一次解析 + keep-alive 注释跳过", () => {
    const buf =
      ": keep-alive\n\n" +
      'event: text_delta\ndata: {"type":"text_delta","messageId":"m1","text":"a"}\n\n' +
      'event: result\ndata: {"type":"result","subtype":"success","text":"完成"}\n\n';
    const { events, rest } = parseSSEBuffer(buf);
    expect(events).toEqual([
      { type: "text_delta", messageId: "m1", text: "a" },
      { type: "result", subtype: "success", text: "完成" },
    ]);
    expect(rest).toBe("");
  });

  it("data 损坏（非 JSON）时丢弃该事件不抛错", () => {
    const { events } = parseSSEBuffer("event: text\ndata: {broken}\n\n");
    expect(events).toEqual([]);
  });

  it("event 行缺失但 data 合法时仍解析（靠 data.type 判别）", () => {
    const { events } = parseSSEBuffer('data: {"type":"error","error":"boom"}\n\n');
    expect(events).toEqual([{ type: "error", error: "boom" }]);
  });
});
