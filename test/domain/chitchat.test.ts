import { describe, expect, it } from "vitest";
import { isLikelyChitchat } from "../../src/domain/chitchat.js";

describe("isLikelyChitchat（闲聊短路径判定）", () => {
  it("问候/致谢/确认/告别/敷衍类整句命中", () => {
    for (const text of [
      "你好",
      "您好！",
      "哈喽~",
      "hello",
      "在吗",
      "在吗？",
      "谢谢",
      "多谢啦！",
      "thanks",
      "Thank you!",
      "收到",
      "好的。",
      "ok",
      "Got it!",
      "嗯",
      "嗯嗯嗯",
      "哈哈",
      "哈哈哈哈",
      "666",
      "再见",
      "拜拜~",
      "早上好！",
      "晚安",
      "测试",
    ]) {
      expect(isLikelyChitchat(text), text).toBe(true);
    }
  });

  it("带任务语义的输入不判闲聊（宁漏放不误收）", () => {
    for (const text of [
      "你好，帮我写个报告",
      "帮我查一下明天天气",
      "修复登录 bug",
      "分析一下这份数据",
      "总结这个仓库的架构",
      "把这个翻译成英文，谢谢",
      "在吗？帮我创建一个智能体",
    ]) {
      expect(isLikelyChitchat(text), text).toBe(false);
    }
  });

  it("含引用/任务面标记一律放行给 dispatcher", () => {
    for (const text of ["你好 @file.ts", "//code-review 你好", "$jihulab 你好", "%会话 你好", "#反馈 你好", "看下 https://example.com", "你好\n世界", "`code`"]) {
      expect(isLikelyChitchat(text), text).toBe(false);
    }
  });

  it("超长与空输入不判闲聊", () => {
    expect(isLikelyChitchat("")).toBe(false);
    expect(isLikelyChitchat("   ")).toBe(false);
    expect(isLikelyChitchat("你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好你好")).toBe(false);
  });
});
