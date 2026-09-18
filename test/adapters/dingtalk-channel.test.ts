import type { RobotTextMessage } from "dingtalk-stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../../src/domain/types.js";

vi.mock("../../src/util/dingtalk-api.js", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  buildSingleSendBody: vi.fn((robotCode: string, userId: string, msg: { markdown?: boolean }) => ({
    robotCode,
    userIds: [userId],
    msgKey: msg?.markdown ? "sampleMarkdownMsg" : "sampleText",
    msgParam: "{}",
  })),
  sendSingleMessage: vi.fn(async () => undefined),
}));

import { DingTalkChannel, normalizeDingTalkMessage } from "../../src/adapters/dingtalk-channel.js";
import { sendSingleMessage } from "../../src/util/dingtalk-api.js";

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
  });

  it("查 recipient → 取 token → singleSend", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", "staff1");
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
});

describe("DingTalkChannel 审批交互", () => {
  beforeEach(() => {
    vi.mocked(sendSingleMessage).mockClear();
  });

  it("requestApproval 发 markdown 提示；回复「通过」→ approved", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", "staff1");
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
    ch.recipients.set("cid", "staff1");
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
    ch.recipients.set("cid", "staff1");
    const got: string[] = [];
    ch.handler = (m) => got.push(m.text);
    const p = ch.requestApproval("cid", { gateId: "g", title: "T", summary: "S" });
    ch.routeIncoming(mkMsg("通过", "cid"));
    await p;
    ch.routeIncoming(mkMsg("下一个任务", "cid"));
    expect(got).toEqual(["下一个任务"]);
  });
});
