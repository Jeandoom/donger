import { describe, expect, it } from "vitest";
import { friendlyRunnerError } from "../../src/util/runner-error-message.js";

describe("friendlyRunnerError", () => {
  it("session 过期 → 可行动的中文提示", () => {
    expect(friendlyRunnerError("Claude Code returned an error result: No conversation found with session ID: 9b7d512b")).toBe(
      "会话状态已失效且自动恢复未成功，请重发任务即可继续",
    );
  });

  it("LLM 端点不可达 → 网络/端点提示", () => {
    expect(friendlyRunnerError("API Error: Unable to connect to API (ConnectionRefused)")).toBe(
      "LLM 服务暂时不可达（网络或端点故障），请稍后重试；持续出现请检查 LLM 端点配置",
    );
    expect(friendlyRunnerError("fetch failed: ETIMEDOUT")).toBe(
      "LLM 服务暂时不可达（网络或端点故障），请稍后重试；持续出现请检查 LLM 端点配置",
    );
  });

  it("凭证/限流错误 → 对应提示", () => {
    expect(friendlyRunnerError("invalid api key")).toBe("LLM 凭证无效或已过期，请检查模型配置后重试");
    expect(friendlyRunnerError("Error: 429 rate limit exceeded")).toBe("LLM 服务限流，请稍后重试");
  });

  it("未知错误原样透出（不丢诊断信息）", () => {
    const raw = "some unexpected internal failure";
    expect(friendlyRunnerError(raw)).toBe(raw);
  });

  it("空/undefined → 兜底文案", () => {
    expect(friendlyRunnerError(undefined)).toBe("任务执行失败");
    expect(friendlyRunnerError("  ")).toBe("任务执行失败");
  });
});
