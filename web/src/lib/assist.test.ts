import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { noneAssistHint } from "./assist";

const NONE_TEXT = "🤷 暂无能处理该任务的智能体：缺能力";

function msg(role: "user" | "bot", text: string): ChatMessage {
  return { id: role + text.length, role, text };
}

describe("noneAssistHint", () => {
  it("命中 none 标记 → 返回携带原任务的预填文本", () => {
    const messages = [msg("user", "帮我查本周提交"), msg("bot", NONE_TEXT)];
    expect(noneAssistHint(messages)).toBe(
      "我想完成：帮我查本周提交。请协助创建能处理该任务的 agent 与 skills。",
    );
  });

  it("最后一条 bot 消息不命中 → null", () => {
    expect(noneAssistHint([msg("user", "x"), msg("bot", "正常回复")])).toBeNull();
  });

  it("无用户消息 → null", () => {
    expect(noneAssistHint([msg("bot", NONE_TEXT)])).toBeNull();
  });
});
