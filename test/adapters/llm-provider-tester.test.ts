import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmProviderTester } from "../../src/adapters/llm-provider-tester.js";

const TARGET = {
  baseUrl: "https://llm.example.com/anthropic",
  key: "sk-test",
  model: "glm-4.6",
};

function mockFetchOnce(impl: (input: string, init?: RequestInit) => Promise<unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => impl(input.toString(), init)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlmProviderTester", () => {
  it("200 + content 数组 → 连接成功", async () => {
    mockFetchOnce(
      async () => new Response(JSON.stringify({ content: [{ type: "text" }] }), { status: 200 }),
    );
    const result = await new LlmProviderTester().test(TARGET);
    expect(result).toEqual({ ok: true, model: "glm-4.6" });
  });

  it("2xx + choices → OpenAI 协议（protocol）", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const result = await new LlmProviderTester().test(TARGET);
    expect(result).toMatchObject({ ok: false, kind: "protocol" });
  });

  it("401 → auth", async () => {
    mockFetchOnce(async () => new Response("{}", { status: 401 }));
    const result = await new LlmProviderTester().test(TARGET);
    expect(result).toMatchObject({ ok: false, kind: "auth" });
  });

  it("5xx → bad_request", async () => {
    mockFetchOnce(async () => new Response("boom", { status: 500 }));
    const result = await new LlmProviderTester().test(TARGET);
    expect(result).toMatchObject({ ok: false, kind: "bad_request" });
  });

  it("网络异常 → network", async () => {
    mockFetchOnce(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await new LlmProviderTester().test(TARGET);
    expect(result).toMatchObject({ ok: false, kind: "network" });
  });

  it("请求打到 {baseUrl}/v1/messages 且带双鉴权头与版本头", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    mockFetchOnce(async (input, init) => {
      capturedUrl = input;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    });
    await new LlmProviderTester().test({ ...TARGET, baseUrl: "https://x.example.com/anthropic/" });
    expect(capturedUrl).toBe("https://x.example.com/anthropic/v1/messages");
    expect(capturedHeaders["x-api-key"]).toBe("sk-test");
    expect(capturedHeaders.authorization).toBe("Bearer sk-test");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
  });
});
