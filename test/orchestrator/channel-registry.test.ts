import { describe, expect, it } from "vitest";
import { DingTalkChannelAdapter } from "../../src/adapters/channel-dingtalk.js";
import { EmailChannelAdapter } from "../../src/adapters/channel-email.js";
import { TeambitionChannelAdapter } from "../../src/adapters/channel-teambition.js";
import { WebhookChannelAdapter } from "../../src/adapters/channel-webhook.js";
import { ChannelConnectionRegistry } from "../../src/orchestrator/channel-registry.js";

describe("ChannelConnectionRegistry", () => {
  it("注册/list/get：重复注册抛错（渠道键唯一）", () => {
    const registry = new ChannelConnectionRegistry();
    const a = new WebhookChannelAdapter();
    registry.register(a);
    expect(() => registry.register(new WebhookChannelAdapter())).toThrow(/重复注册/);
    expect(registry.get("webhook")).toBe(a);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.list().map((x) => x.id)).toEqual(["webhook"]);
  });
});

describe("DingTalkChannelAdapter", () => {
  it("available：配置完整才可用；testConnection 缺配置 fail-fast 不发外部请求", async () => {
    const adapter = new DingTalkChannelAdapter(() => undefined);
    expect(adapter.available()).toBe(false);
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("配置不完整");
  });

  it("capabilities：outboundPush + replyToSource + 入站 stream；status 反映长连接状态", () => {
    const adapter = new DingTalkChannelAdapter(() => ({
      appKey: "k",
      appSecret: "s",
      robotCode: "r",
    }));
    expect(adapter.capabilities).toEqual({
      outboundPush: true,
      replyToSource: true,
      inbound: "stream",
    });
    expect(adapter.status().inbound).toMatchObject({ mode: "stream", connected: false });
  });

  it("入站状态随通道引用解析（getter 延迟绑定）", () => {
    let channel: { isRunning(): boolean } | undefined;
    const adapter = new DingTalkChannelAdapter(
      () => ({ appKey: "k", appSecret: "s", robotCode: "r" }),
      () => channel,
    );
    expect(adapter.status().inbound).toMatchObject({ connected: false });
    channel = { isRunning: () => true };
    expect(adapter.status().inbound).toMatchObject({ connected: true });
  });
});

describe("TeambitionChannelAdapter", () => {
  const cfg = { appKey: "k", appSecret: "s", orgId: "o" };

  it("available：插件门 + 配置完整性双条件", () => {
    expect(new TeambitionChannelAdapter(() => cfg, () => true).available()).toBe(true);
    expect(new TeambitionChannelAdapter(() => cfg, () => false).available()).toBe(false);
    expect(new TeambitionChannelAdapter(() => undefined, () => true).available()).toBe(false);
  });

  it("capabilities：仅回原 + 入站 webhook（无个人级出站推送）", () => {
    const adapter = new TeambitionChannelAdapter(() => cfg);
    expect(adapter.capabilities).toEqual({
      outboundPush: false,
      replyToSource: true,
      inbound: "webhook",
    });
    expect(adapter.status().inbound).toMatchObject({ mode: "webhook", connected: true });
  });
});

describe("EmailChannelAdapter / WebhookChannelAdapter", () => {
  it("email：SMTP 在位才可用；testConnection 缺配置 fail-fast", async () => {
    const missing = new EmailChannelAdapter(() => undefined);
    expect(missing.available()).toBe(false);
    expect((await missing.testConnection()).ok).toBe(false);
    const ok = new EmailChannelAdapter(() => ({
      signupAllowedDomains: [],
      loginEnabled: false,
      smtp: { host: "smtp.example.com", port: 465, secure: true, from: "n@example.com" },
    }));
    expect(ok.available()).toBe(true);
    expect(ok.capabilities).toEqual({ outboundPush: true, replyToSource: false, inbound: null });
  });

  it("webhook：按用户地址簿配置，available 恒真、测试指向地址簿探活", async () => {
    const adapter = new WebhookChannelAdapter();
    expect(adapter.available()).toBe(true);
    expect(adapter.configSource).toBe("address_book");
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("地址簿");
  });
});
