import { describe, expect, it } from "vitest";
import type { ReplyAnchor } from "../../src/domain/event.js";
import type {
  ChannelAdapter,
  ChannelReplyMessage,
} from "../../src/ports/channel-adapter.js";
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

describe("ChannelConnectionRegistry.replyToSource", () => {
  const anchor: ReplyAnchor = { platform: "test", kind: "group", target: { threadId: "t1" } };
  const message: ChannelReplyMessage = { body: "hello" };

  function makeAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
    return {
      id: "test",
      displayName: "测试渠道",
      description: "",
      capabilities: { outboundPush: false, replyToSource: true, inbound: null },
      configSource: "connection",
      configHint: "",
      available: () => true,
      testConnection: async () => ({ ok: true }),
      replyToSource: async (a, m) => ({
        ok: true,
        receipt: { threadId: a.target.threadId },
        ...(m ? {} : {}),
      }),
      ...overrides,
    };
  }

  it("按 anchor.platform 路由并把锚点原样传给适配器", async () => {
    const seen: Array<{ anchor: ReplyAnchor; message: ChannelReplyMessage }> = [];
    const adapter = makeAdapter({
      replyToSource: async (a, m) => {
        seen.push({ anchor: a, message: m });
        return { ok: true, receipt: { threadId: a.target.threadId } };
      },
    });
    const registry = new ChannelConnectionRegistry();
    registry.register(adapter);
    const delivery = await registry.replyToSource(anchor, message);
    expect(delivery.ok).toBe(true);
    expect(delivery.receipt).toMatchObject({ threadId: "t1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.anchor).toBe(anchor);
  });

  it("未注册平台抛错（原 sourceDeliver if/else 的『不支持的平台锚点』语义收编）", async () => {
    const registry = new ChannelConnectionRegistry();
    await expect(registry.replyToSource({ ...anchor, platform: "ghost" }, message)).rejects.toThrow(
      "回源平台未注册: ghost",
    );
  });

  it("渠道不支持回原抛错；未启用抛错（不静默降级）", async () => {
    const noReply = makeAdapter({
      capabilities: { outboundPush: true, replyToSource: false, inbound: null },
      replyToSource: undefined,
    });
    const registry = new ChannelConnectionRegistry();
    registry.register(noReply);
    await expect(registry.replyToSource(anchor, message)).rejects.toThrow("不支持回原投递");

    const disabled = makeAdapter({ available: () => false });
    const registry2 = new ChannelConnectionRegistry();
    registry2.register(disabled);
    await expect(registry2.replyToSource(anchor, message)).rejects.toThrow("未启用");
  });

  it("真实适配器路由：dingtalk 锚点走群 send、形态不符 fail-closed", async () => {
    let sent: Array<{ threadId: string; text: string }> = [];
    const channel = {
      isRunning: () => true,
      send: async (threadId: string, m: { text: string }) => {
        sent.push({ threadId, text: m.text });
      },
    } as never;
    const adapter = new DingTalkChannelAdapter(
      () => ({ appKey: "k", appSecret: "s", robotCode: "r" }),
      () => channel,
    );
    const registry = new ChannelConnectionRegistry();
    registry.register(adapter);
    await registry.replyToSource(
      { platform: "dingtalk", kind: "group", target: { threadId: "cid" } },
      { body: "回群内容" },
    );
    expect(sent).toEqual([{ threadId: "cid", text: "回群内容" }]);

    await expect(
      registry.replyToSource(
        { platform: "dingtalk", kind: "task", target: { taskId: "x" } },
        { body: "x" },
      ),
    ).rejects.toThrow("形态不符");
  });
});
