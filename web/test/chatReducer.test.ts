import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../src/lib/chatReducer";
import type { ConversationSummary, WsOut } from "../src/types";

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

  it("ws:result 只结束生成状态，不重复追加 bot 消息", () => {
    const msg: WsOut = { type: "result", subtype: "success", text: "完成" };
    const running = chatReducer(initialChatState(), { type: "generation", running: true });
    const s = chatReducer(running, { type: "ws", msg });
    expect(s.messages).toHaveLength(0);
    expect(s.isGenerating).toBe(false);
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

  it("初始状态包含 conversations 和 activeConversationId", () => {
    const s = initialChatState();
    expect(s.conversations).toEqual([]);
    expect(s.activeConversationId).toBeNull();
    expect(s.loadingConversations).toBe(true);
  });

  it("set_conversations 更新会话列表并取消加载", () => {
    const conv: ConversationSummary = {
      id: "c1",
      userId: "u1",
      sdkSessionId: "s1",
      title: "测试",
      channelId: "web",
      createdAt: "t",
      updatedAt: "t",
      archived: false,
    };
    const s = chatReducer(initialChatState(), { type: "set_conversations", conversations: [conv] });
    expect(s.conversations).toHaveLength(1);
    expect(s.conversations[0]?.title).toBe("测试");
    expect(s.loadingConversations).toBe(false);
  });

  it("switch_conversation 清空消息并切换 ID", () => {
    const s1 = chatReducer(initialChatState(), { type: "user_message", text: "旧消息" });
    const s2 = chatReducer(s1, { type: "switch_conversation", conversationId: "c2" });
    expect(s2.activeConversationId).toBe("c2");
    expect(s2.messages).toHaveLength(0);
  });

  it("new_conversation 添加到列表头部并设为活跃", () => {
    const conv: ConversationSummary = {
      id: "c-new",
      userId: "u1",
      sdkSessionId: "",
      title: "新对话",
      channelId: "web",
      createdAt: "t",
      updatedAt: "t",
      archived: false,
    };
    // 先有一条旧会话
    const old: ConversationSummary = {
      id: "c-old",
      userId: "u1",
      sdkSessionId: "",
      title: "旧",
      channelId: "web",
      createdAt: "t",
      updatedAt: "t",
      archived: false,
    };
    const s0 = chatReducer(initialChatState(), { type: "set_conversations", conversations: [old] });
    const s = chatReducer(s0, { type: "new_conversation", conversation: conv });
    expect(s.conversations).toHaveLength(2);
    expect(s.conversations[0]?.id).toBe("c-new");
    expect(s.activeConversationId).toBe("c-new");
    expect(s.loadingConversations).toBe(false);
  });
});
