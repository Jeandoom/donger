import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";
import type { WsOut } from "../src/types";

describe("chatReducer", () => {
  it("user_message 追加一条 user 消息", () => {
    const s = chatReducer(initialChatState(), { type: "user_message", text: "你好" });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.text).toBe("你好");
  });

  it("ws:text 追加一条 bot 消息", () => {
    const msg: WsOut = { type: "text", text: "在的" };
    const s = chatReducer(initialChatState(), { type: "ws", msg });
    expect(s.messages[0]?.role).toBe("bot");
    expect(s.messages[0]?.text).toBe("在的");
  });

  it("ws:approval_card 设置 pendingApproval", () => {
    const msg: WsOut = {
      type: "approval_card",
      gateId: "g1",
      title: "部署确认",
      summary: "将执行 deploy",
    };
    const s = chatReducer(initialChatState(), { type: "ws", msg });
    expect(s.pendingApproval?.gateId).toBe("g1");
    expect(s.pendingApproval?.title).toBe("部署确认");
  });

  it("ws:result 追加一条 bot 消息", () => {
    const msg: WsOut = { type: "result", subtype: "success", text: "完成" };
    const s = chatReducer(initialChatState(), { type: "ws", msg });
    expect(s.messages[0]?.text).toBe("完成");
    expect(s.messages[0]?.role).toBe("bot");
  });

  it("clear_approval 清空 pendingApproval", () => {
    const set = chatReducer(initialChatState(), {
      type: "ws",
      msg: { type: "approval_card", gateId: "g1", title: "t", summary: "s" },
    });
    const cleared = chatReducer(set, { type: "clear_approval" });
    expect(cleared.pendingApproval).toBeNull();
  });

  it("connection 更新连接状态", () => {
    const s = chatReducer(initialChatState(), { type: "connection", state: "open" });
    expect(s.connection).toBe("open");
  });
});
