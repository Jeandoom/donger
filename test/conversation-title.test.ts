import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
} from "../src/domain/conversation-title.js";

describe("deriveConversationTitle", () => {
  it("单行消息原样截取", () => {
    expect(deriveConversationTitle("帮我整理这份物料清单")).toBe("帮我整理这份物料清单");
  });

  it("超长截到 30 字", () => {
    const title = deriveConversationTitle(
      "这是一个非常长的第一句话用来验证三十个字符的截断行为对不对呀朋友们",
    );
    expect([...title]).toHaveLength(30);
    expect(title.startsWith("这是一个非常长的第一句话用来验证三十")).toBe(true);
  });

  it("多行消息取首个非空行（贴代码/报错不被正文淹没）", () => {
    const text = "\n  \n修复登录页 402 报错\nconst a = 1;\n";
    expect(deriveConversationTitle(text)).toBe("修复登录页 402 报错");
  });

  it("行内连续空白压平为单空格", () => {
    expect(deriveConversationTitle("帮忙   看\t一下  这段日志")).toBe("帮忙 看 一下 这段日志");
  });

  it("纯空白消息返回空串（调用方跳过改名）", () => {
    expect(deriveConversationTitle("  \n\t ")).toBe("");
    expect(deriveConversationTitle("")).toBe("");
  });

  it("代理对（emoji）按码点截断，不出现半个字符", () => {
    const text = "🎉".repeat(40);
    const title = deriveConversationTitle(text);
    expect([...title]).toHaveLength(30);
    expect([...title].every((ch) => ch === "🎉")).toBe(true);
  });

  it("默认标题常量为「新对话」", () => {
    expect(DEFAULT_CONVERSATION_TITLE).toBe("新对话");
  });
});
