import { describe, expect, it } from "vitest";
import { LarkChannelAdapter } from "../../src/adapters/channel-lark.js";

/** fetch mock：按 URL 前缀分发（token/发送/回复），记录调用 */
function larkFetchMock(handlers: {
  token?: () => { code: number; tenant_access_token?: string; expire?: number; msg?: string };
  send?: (body: Record<string, unknown>) => { code: number; msg?: string; data?: { message_id?: string } };
  reply?: (body: Record<string, unknown>) => { code: number; msg?: string; data?: { message_id?: string } };
}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url, body });
    let out: Record<string, unknown> = {};
    if (url.includes("tenant_access_token")) {
      out = handlers.token?.() ?? { code: 0, tenant_access_token: "tk", expire: 7200 };
    } else if (url.includes("/reply")) {
      out = handlers.reply?.(body) ?? { code: 0, data: { message_id: "om-reply" } };
    } else if (url.includes("/messages")) {
      out = handlers.send?.(body) ?? { code: 0, data: { message_id: "om-send" } };
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const cfg = { appId: "cli-x", appSecret: "sec", verificationToken: "vt" };

describe("LarkChannelAdapter（M4 四步接入样板）", () => {
  it("available/testConnection：配置完整性 + tenant token 真实探活", async () => {
    const missing = new LarkChannelAdapter(() => undefined);
    expect(missing.available()).toBe(false);
    expect((await missing.testConnection()).ok).toBe(false);

    const { impl } = larkFetchMock({});
    const adapter = new LarkChannelAdapter(() => cfg, impl);
    expect(adapter.available()).toBe(true);
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("tenant_access_token");
  });

  it("send：open_id 文本消息 + Bearer token；业务非零码回 error", async () => {
    const { impl, calls } = larkFetchMock({});
    const adapter = new LarkChannelAdapter(() => cfg, impl);
    const delivery = await adapter.send("ou-123", "标题", "正文");
    expect(delivery.ok).toBe(true);
    const sendCall = calls.find((c) => c.url.includes("/messages"));
    expect(sendCall?.body).toMatchObject({ receive_id: "ou-123", msg_type: "text" });
    expect(JSON.parse(sendCall?.body.content as string).text).toContain("标题");

    const fail = larkFetchMock({ send: () => ({ code: 99991668, msg: "token invalid" }) });
    const bad = new LarkChannelAdapter(() => cfg, fail.impl);
    const out = await bad.send("ou-123", "t", "b");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("99991668");
  });

  it("replyToSource：锚点线程回复；形态不符 fail-closed", async () => {
    const { impl, calls } = larkFetchMock({});
    const adapter = new LarkChannelAdapter(() => cfg, impl);
    const delivery = await adapter.replyToSource(
      { platform: "lark", kind: "chat", target: { messageId: "om-1", chatId: "oc-1" } },
      { body: "回线程内容" },
    );
    expect(delivery.ok).toBe(true);
    const replyCall = calls.find((c) => c.url.includes("/om-1/reply"));
    expect(replyCall).toBeTruthy();
    expect(JSON.parse(replyCall?.body.content as string).text).toBe("回线程内容");

    await expect(
      adapter.replyToSource(
        { platform: "lark", kind: "group", target: { chatId: "oc" } },
        { body: "x" },
      ),
    ).rejects.toThrow("形态不符");
  });

  it("normalizeWebhook：im.message.received_v1 → 统一信封（锚点=message 线程）；其他事件 null", () => {
    const adapter = new LarkChannelAdapter(() => cfg);
    const envelope = adapter.normalizeWebhook({
      header: { event_type: "im.message.received_v1" },
      event: {
        message: {
          message_id: "om-9",
          chat_id: "oc-9",
          message_type: "text",
          content: '{"text":"@bot 帮我查订单"}',
        },
        sender: { sender_id: { open_id: "ou-9" } },
      },
    });
    expect(envelope).toMatchObject({
      platform: "lark",
      topic: "im.message",
      eventId: "om-9",
      sender: { id: "ou-9" },
      text: "@bot 帮我查订单",
    });
    expect(envelope?.replyAnchor).toEqual({
      platform: "lark",
      kind: "chat",
      target: { messageId: "om-9", chatId: "oc-9" },
    });
    expect(adapter.normalizeWebhook({ header: { event_type: "other.event" } })).toBeNull();
  });

  it("verifyWebhook：token 匹配；配置为空=跳过校验", () => {
    const strict = new LarkChannelAdapter(() => cfg);
    expect(strict.verifyWebhook({ header: { token: "vt" } })).toBe(true);
    expect(strict.verifyWebhook({ header: { token: "bad" } })).toBe(false);
    const loose = new LarkChannelAdapter(() => ({ appId: "a", appSecret: "b" }));
    expect(loose.verifyWebhook({ header: {} })).toBe(true);
  });
});
