import type { RobotTextMessage } from "dingtalk-stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../../src/domain/types.js";

// DWClient 假件：捕获 TOPIC_ROBOT 回调，供 onMessage 群路由分支测试
let robotCallback: ((msg: { data: string; headers: { messageId: string } }) => Promise<void>) | null =
  null;
vi.mock("dingtalk-stream", async (importOriginal) => {
  const orig = await importOriginal<typeof import("dingtalk-stream")>();
  return {
    ...orig,
    DWClient: class {
      registerCallbackListener(_topic: string, cb: never) {
        robotCallback = cb as never;
        return this;
      }
      socketCallBackResponse = vi.fn();
      async connect(): Promise<void> {}
      disconnect(): void {}
    },
  };
});

vi.mock("../../src/util/dingtalk-api.js", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  buildSingleSendBody: vi.fn((robotCode: string, userId: string, msg: { markdown?: boolean }) => ({
    robotCode,
    userIds: [userId],
    msgKey: msg?.markdown ? "sampleMarkdownMsg" : "sampleText",
    msgParam: "{}",
  })),
  sendSingleMessage: vi.fn(async () => undefined),
  buildGroupSendBody: vi.fn(
    (robotCode: string, openConversationId: string, msg: { markdown?: boolean }) => ({
      robotCode,
      openConversationId,
      msgKey: msg?.markdown ? "sampleMarkdownMsg" : "sampleText",
      msgParam: "{}",
    }),
  ),
  sendGroupMessage: vi.fn(async () => undefined),
}));

import { DingTalkChannel, normalizeDingTalkMessage } from "../../src/adapters/dingtalk-channel.js";
import { sendGroupMessage, sendSingleMessage } from "../../src/util/dingtalk-api.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const baseRobot: RobotTextMessage = {
  conversationId: "cid-1",
  chatbotCorpId: "c",
  chatbotUserId: "b",
  msgId: "m1",
  senderNick: "张三",
  isAdmin: false,
  senderStaffId: "staff-1",
  sessionWebhookExpiredTime: 0,
  createAt: 0,
  senderCorpId: "sc",
  conversationType: "1",
  senderId: "sender-1",
  sessionWebhook: "https://sw",
  robotCode: "rc",
  msgtype: "text",
  text: { content: " 做某事 " },
};

function mkMsg(text: string, threadId = "cid"): IncomingMessage {
  return { channelId: "dingtalk", threadId, requesterId: "staff-1", text };
}

describe("normalizeDingTalkMessage", () => {
  it("归一为 IncomingMessage（trim 文本）", () => {
    expect(normalizeDingTalkMessage(baseRobot)).toEqual({
      channelId: "dingtalk",
      threadId: "cid-1",
      requesterId: "staff-1",
      text: "做某事",
    });
  });
  it("content 为空串时 text 为空", () => {
    expect(normalizeDingTalkMessage({ ...baseRobot, text: { content: "" } }).text).toBe("");
  });
  it("@机器人 前缀被剥离（群聊防御；单聊 no-op）", () => {
    expect(
      normalizeDingTalkMessage({ ...baseRobot, text: { content: "@机器人 加个接口" } }).text,
    ).toBe("加个接口");
  });
});

describe("DingTalkChannel.send", () => {
  beforeEach(() => {
    vi.mocked(sendSingleMessage).mockClear();
    vi.mocked(sendGroupMessage).mockClear();
  });

  it("查 recipient → 取 token → singleSend", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", { userId: "staff1" });
    await ch.send("cid", { text: "hi" });
    expect(sendSingleMessage).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ robotCode: "rc", userIds: ["staff1"] }),
    );
  });

  it("recipient 缺失抛错", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    await expect(ch.send("nope", { text: "hi" })).rejects.toThrow(/recipient/);
  });

  it("群消息（conversationType=2）→ groupMessages/send 回源到群，不走单聊", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid-group", { userId: "staff1", conversationType: "2" });
    await ch.send("cid-group", { text: "群里回复" });
    expect(sendGroupMessage).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ robotCode: "rc", openConversationId: "cid-group" }),
    );
    expect(sendSingleMessage).not.toHaveBeenCalled();
  });

  it("群回复失败（如 openConversationId 不符）→ 回退单聊保送达", async () => {
    vi.mocked(sendGroupMessage).mockRejectedValueOnce(
      new Error("钉钉 groupSend 失败 (400): invalid.openConversationId"),
    );
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid-group", { userId: "staff1", conversationType: "2" });
    await ch.send("cid-group", { text: "群里回复" });
    expect(sendGroupMessage).toHaveBeenCalledOnce();
    expect(sendSingleMessage).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ robotCode: "rc", userIds: ["staff1"] }),
    );
  });
});

describe("DingTalkChannel 审批交互", () => {
  beforeEach(() => {
    vi.mocked(sendSingleMessage).mockClear();
  });

  it("requestApproval 发 markdown 提示；回复「通过」→ approved", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", { userId: "staff1" });
    const p = ch.requestApproval("cid", { gateId: "g", title: "T", summary: "S" });
    ch.routeIncoming(mkMsg("通过", "cid"));
    const d = await p;
    expect(d.approved).toBe(true);
    await tick();
    expect(sendSingleMessage).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ msgKey: "sampleMarkdownMsg" }),
    );
  });

  it("回复非通过关键词 → denied（reason 含原回复）", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", { userId: "staff1" });
    const p = ch.requestApproval("cid", { gateId: "g", title: "T", summary: "S" });
    ch.routeIncoming(mkMsg("先别部署", "cid"));
    const d = await p;
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("先别部署");
  });

  it("无 pending 时 routeIncoming 转发给 handler（新任务）", () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    const got: string[] = [];
    ch.handler = (m) => got.push(m.text);
    ch.routeIncoming(mkMsg("做个接口", "c1"));
    expect(got).toEqual(["做个接口"]);
  });

  it("pending 被消费后，后续消息正常转发", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", { userId: "staff1" });
    const got: string[] = [];
    ch.handler = (m) => got.push(m.text);
    const p = ch.requestApproval("cid", { gateId: "g", title: "T", summary: "S" });
    ch.routeIncoming(mkMsg("通过", "cid"));
    await p;
    ch.routeIncoming(mkMsg("下一个任务", "cid"));
    expect(got).toEqual(["下一个任务"]);
  });
});

describe("群消息事件路由（spec 2026-10-27 §4.2 M1）", () => {
  const groupRobot: RobotTextMessage = {
    ...baseRobot,
    conversationId: "cid-group-1",
    conversationType: "2",
    msgId: "msg-77",
    text: { content: "@机器人 帮我查下库存" },
  };

  beforeEach(() => {
    robotCallback = null;
  });

  it("buildDingTalkGroupEnvelope：信封含去重键/发送人/回源锚点，text 剥 @ 前缀", async () => {
    const { buildDingTalkGroupEnvelope } = await import("../../src/adapters/dingtalk-channel.js");
    const env = buildDingTalkGroupEnvelope(groupRobot);
    expect(env.platform).toBe("dingtalk");
    expect(env.topic).toBe("robot.group");
    expect(env.eventId).toBe("msg-77");
    expect(env.sender).toEqual({ id: "staff-1", name: "张三" });
    expect(env.source).toEqual({ openConversationId: "cid-group-1", conversationType: "2" });
    expect(env.text).toBe("帮我查下库存");
    expect(env.replyAnchor).toEqual({
      platform: "dingtalk",
      kind: "group",
      threadId: "cid-group-1",
    });
  });

  it("群消息命中订阅（handler 返回 true）→ 消费，不进聊天 handler", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    const got: string[] = [];
    ch.onMessage((m) => got.push(m.text));
    ch.onGroupMessage(async () => true);
    await robotCallback?.({ data: JSON.stringify(groupRobot), headers: { messageId: "m-1" } });
    expect(got).toEqual([]);
  });

  it("无订阅/未消费（handler 返回 false）→ 回落对话语义", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    const got: string[] = [];
    ch.onMessage((m) => got.push(m.text));
    ch.onGroupMessage(async () => false);
    await robotCallback?.({ data: JSON.stringify(groupRobot), headers: { messageId: "m-2" } });
    expect(got).toEqual(["帮我查下库存"]);
  });

  it("路由器抛错 → 回落对话（不吞消息）", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    const got: string[] = [];
    ch.onMessage((m) => got.push(m.text));
    ch.onGroupMessage(async () => {
      throw new Error("路由炸了");
    });
    await robotCallback?.({ data: JSON.stringify(groupRobot), headers: { messageId: "m-3" } });
    expect(got).toEqual(["帮我查下库存"]);
  });
});
