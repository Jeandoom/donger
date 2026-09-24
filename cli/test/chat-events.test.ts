import { describe, expect, it } from "vitest";
import { classifyEvent } from "../src/chat-events.js";

describe("classifyEvent", () => {
  it("text_delta 进入流式态并输出增量", () => {
    const s = { messageId: null };
    expect(classifyEvent({ type: "text_delta", messageId: "m1", text: "he" }, s)).toEqual({
      kind: "delta",
      text: "he",
    });
    expect(s.messageId).toBe("m1");
  });

  it("流式后的完整 text 跳过（防重复）并退出流式态", () => {
    const s = { messageId: "m1" };
    expect(classifyEvent({ type: "text", text: "hello" }, s)).toEqual({ kind: "ignore" });
    expect(s.messageId).toBe(null);
  });

  it("无流式态的完整 text 正常输出", () => {
    const s = { messageId: null };
    expect(classifyEvent({ type: "text", text: "答案" }, s)).toEqual({
      kind: "print",
      text: "答案",
    });
  });

  it("空 text（连接确认）忽略", () => {
    expect(classifyEvent({ type: "text", text: "" }, { messageId: null })).toEqual({
      kind: "ignore",
    });
  });

  it("审批卡片 → approval 动作（老事件缺 approvalId 时 respondId 退回 gateId）", () => {
    const s = { messageId: null };
    expect(
      classifyEvent({ type: "approval_card", gateId: "g1", title: "部署", summary: "确认?" }, s),
    ).toEqual({
      kind: "approval",
      respondId: "g1",
      gateId: "g1",
      title: "部署",
      summary: "确认?",
    });
    // 新服务端携带一次性 approvalId：respond 目标 = approvalId
    expect(
      classifyEvent(
        {
          type: "approval_card",
          approvalId: "a-uuid",
          gateId: "g1",
          title: "部署",
          summary: "确认?",
        },
        s,
      ),
    ).toEqual({
      kind: "approval",
      respondId: "a-uuid",
      gateId: "g1",
      title: "部署",
      summary: "确认?",
    });
  });

  it("缺失卡片 → credential_missing 动作", () => {
    const s = { messageId: null };
    const r = classifyEvent(
      {
        type: "credential_missing_card",
        reqId: "r1",
        conversationId: "c1",
        items: [{ code: "c1", name: "密钥", keys: ["token"] }],
      },
      s,
    );
    expect(r).toMatchObject({ kind: "credential_missing", reqId: "r1" });
  });

  it("result → round_end（success/error）", () => {
    const s = { messageId: null };
    expect(classifyEvent({ type: "result", subtype: "success", text: "完成" }, s)).toEqual({
      kind: "round_end",
      ok: true,
      text: "完成",
    });
    expect(classifyEvent({ type: "result", subtype: "error", text: "失败" }, s)).toEqual({
      kind: "round_end",
      ok: false,
      text: "失败",
    });
  });

  it("error → print", () => {
    expect(classifyEvent({ type: "error", error: "boom" }, { messageId: null })).toEqual({
      kind: "print",
      text: "❌ boom",
    });
  });
});
