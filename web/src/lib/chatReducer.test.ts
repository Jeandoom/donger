import { describe, expect, it } from "vitest";
import type { ChatState, TurnPart } from "../types";
import { chatReducer, initialChatState } from "./chatReducer";

function withMessages(messages: ChatState["messages"]): ChatState {
  return { ...initialChatState(), messages };
}

function textOf(part: TurnPart | undefined): string {
  if (part?.kind !== "text") throw new Error("expected text part");
  return part.text;
}

describe("chatReducer 回合聚合", () => {
  it("thinking/text 增量并入同一回合，分片按时间线有序", () => {
    let state = withMessages([{ id: "u1", role: "user", text: "问" }]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "thinking_delta", messageId: "m1", text: "想一想" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m2", text: "你好" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m2", text: "！" },
    });

    const turn = state.messages[1];
    expect(turn?.kind).toBe("turn");
    expect(turn?.state).toBe("running");
    expect(turn?.parts?.map((p) => p.kind)).toEqual(["thinking", "text"]);
    expect(textOf(turn?.parts?.[1])).toBe("你好！");
    expect(state.isGenerating).toBe(true);
  });

  it("增量不跨工具段合并：工具后的新文本是新分片", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m1", text: "先看文件" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_use", toolUseId: "tu1", tool: "Read", inputPreview: "{}" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m2", text: "读完了" },
    });

    const parts = state.messages[0]?.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
  });

  it("tool_use → tool_result 状态收敛 done/error", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_use", toolUseId: "tu1", tool: "Bash", inputPreview: '{"command":"ls"}' },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_result", toolUseId: "tu1", outputPreview: "ok", isError: false },
    });
    let tool = state.messages[0]?.parts?.[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.state).toBe("done");
    expect(tool.outputPreview).toBe("ok");

    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_use", toolUseId: "tu2", tool: "Bash", inputPreview: "{}" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_result", toolUseId: "tu2", outputPreview: "boom", isError: true },
    });
    tool = state.messages[0]?.parts?.[1];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.state).toBe("error");
  });

  it("result 关闭回合；新事件开新回合", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m1", text: "第一轮" },
    });
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "result", subtype: "success", text: "" },
    });
    expect(state.messages[0]?.state).toBe("done");
    expect(state.isGenerating).toBe(false);

    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m2", text: "第二轮" },
    });
    expect(state.messages.length).toBe(2);
    expect(state.messages[1]?.state).toBe("running");
  });

  it("完整 text 事件作为独立分片追加", () => {
    let state = withMessages([{ id: "u1", role: "user", text: "问" }]);
    state = chatReducer(state, { type: "ws", msg: { type: "text", text: "完整回复" } });
    const parts = state.messages[1]?.parts ?? [];
    expect(parts.length).toBe(1);
    expect(parts[0]?.kind).toBe("text");
    expect(textOf(parts[0])).toBe("完整回复");
  });

  it("新用户消息收口残留回合并切分", () => {
    let state = withMessages([{ id: "u1", role: "user", text: "问1" }]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m1", text: "流式中" },
    });
    state = chatReducer(state, { type: "user_message", text: "问2" });
    expect(state.messages[1]?.state).toBe("done");
    expect(state.messages[2]?.role).toBe("user");
  });

  it("generation running=false 收口进行中的回合（取消/断线）", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "tool_use", toolUseId: "tu1", tool: "Bash", inputPreview: "{}" },
    });
    state = chatReducer(state, { type: "generation", running: false });
    const turn = state.messages[0];
    expect(turn?.state).toBe("done");
    const tool = turn?.parts?.[0];
    if (tool?.kind !== "tool") throw new Error("expected tool part");
    expect(tool.state).toBe("error");
  });

  it("activity 事件更新阶段横幅（替换式），回合收口时清除", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "activity", text: "🔨 执行阶段" },
    });
    expect(state.stage).toBe("🔨 执行阶段");
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "activity", text: "🔍 验收阶段" },
    });
    expect(state.stage).toBe("🔍 验收阶段");
    state = chatReducer(state, { type: "generation", running: false });
    expect(state.stage).toBeNull();
  });

  it("error 事件收口回合为 error", () => {
    let state = withMessages([]);
    state = chatReducer(state, {
      type: "ws",
      msg: { type: "text_delta", messageId: "m1", text: "部分输出" },
    });
    state = chatReducer(state, { type: "ws", msg: { type: "error", error: "挂了" } });
    expect(state.messages[0]?.state).toBe("error");
    expect(state.errors.stream).toBe("挂了");
  });
});

describe("chatReducer AskUserQuestion 状态", () => {
  it("ask_user_question 设置 pendingQuestion，result/error 清除", () => {
    let state = initialChatState();
    state = chatReducer(state, {
      type: "ws",
      msg: {
        type: "ask_user_question",
        reqId: "rq1",
        conversationId: "c1",
        questions: [{ question: "异常表现是什么？", header: "异常表现" }],
      },
    });
    expect(state.pendingQuestion?.reqId).toBe("rq1");
    expect(state.pendingQuestion?.questions[0]?.question).toBe("异常表现是什么？");

    state = chatReducer(state, {
      type: "ws",
      msg: { type: "result", subtype: "success", text: "done" },
    });
    expect(state.pendingQuestion).toBeNull();
  });

  it("switch_conversation 清除 pendingQuestion；set_pending_question 恢复", () => {
    let state = initialChatState();
    state = chatReducer(state, {
      type: "ws",
      msg: {
        type: "ask_user_question",
        reqId: "rq1",
        conversationId: "c1",
        questions: [{ question: "q" }],
      },
    });
    state = chatReducer(state, { type: "switch_conversation", conversationId: "c2" });
    expect(state.pendingQuestion).toBeNull();

    state = chatReducer(state, {
      type: "set_pending_question",
      question: { reqId: "rq2", questions: [{ question: "q2", multiSelect: true }] },
    });
    expect(state.pendingQuestion?.reqId).toBe("rq2");
    state = chatReducer(state, { type: "clear_question" });
    expect(state.pendingQuestion).toBeNull();
  });
});
