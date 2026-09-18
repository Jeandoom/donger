import { describe, expect, it, vi } from "vitest";
import { ClaudeLlmDebugRunner } from "../../src/adapters/claude-llm-debug-runner.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

async function* messages() {
  yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
  yield { type: "result", subtype: "success", result: "ok" };
}

describe("ClaudeLlmDebugRunner", () => {
  it("从历史 query input 提取 prompt 并返回完整 SDK 输出", async () => {
    queryMock.mockReturnValue(messages());
    const runner = new ClaudeLlmDebugRunner();
    const result = await runner.run('{"prompt":"edited","options":{"model":"old"}}', {
      model: "new",
      baseUrl: "https://llm",
      authToken: "secret",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "edited",
        options: expect.objectContaining({ model: "new" }),
      }),
    );
    expect(result.output).toContain('"assistant"');
    expect(result.output).toContain('"result"');
  });
});
