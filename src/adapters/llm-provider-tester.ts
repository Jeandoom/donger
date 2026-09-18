export type LlmTestFailureKind = "network" | "auth" | "protocol" | "bad_request";

export type LlmTestResult =
  | { ok: true; model: string }
  | { ok: false; kind: LlmTestFailureKind; message: string };

export interface LlmTestTarget {
  baseUrl: string;
  key: string;
  model: string;
}

export interface LlmTester {
  test(target: LlmTestTarget): Promise<LlmTestResult>;
}

/**
 * Anthropic 协议连通性校验：向 {baseUrl}/v1/messages 发 max_tokens=1 的最小非流式请求。
 * 判定协议形态（Anthropic content[] vs OpenAI choices）而非仅 HTTP 状态。
 * 只回分类结论，不透传第三方响应体（防错误回显泄漏内网信息）。
 */
export class LlmProviderTester implements LlmTester {
  async test(target: LlmTestTarget): Promise<LlmTestResult> {
    const url = `${target.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          // 官方端点用 x-api-key，兼容端点/网关多用 Bearer——两家都带
          "x-api-key": target.key,
          authorization: `Bearer ${target.key}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: target.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { ok: false, kind: "network", message: "无法连接到该服务地址（网络不可达或超时）" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "auth", message: "API Key 无效或无权限（401/403）" };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        content?: unknown;
        choices?: unknown;
      } | null;
      if (body && Array.isArray(body.choices)) {
        return {
          ok: false,
          kind: "protocol",
          message: "该端点是 OpenAI 协议（choices 响应），不是 Anthropic 兼容端点",
        };
      }
      if (body && Array.isArray(body.content)) {
        return { ok: true, model: target.model };
      }
      return {
        ok: false,
        kind: "protocol",
        message: "响应不是 Anthropic messages 格式（缺少 content 数组）",
      };
    }
    return {
      ok: false,
      kind: "bad_request",
      message: `服务返回错误状态 ${response.status}（模型名无效或端点不支持该请求）`,
    };
  }
}
