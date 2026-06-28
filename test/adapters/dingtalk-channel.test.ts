import type { RobotTextMessage } from "dingtalk-stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/util/dingtalk-api.js", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  buildSingleSendBody: vi.fn((robotCode: string, userId: string) => ({
    robotCode,
    userIds: [userId],
    msgKey: "SampleTextMessage",
    msgParam: "{}",
  })),
  sendSingleMessage: vi.fn(async () => undefined),
}));

import { DingTalkChannel, normalizeDingTalkMessage } from "../../src/adapters/dingtalk-channel.js";
import { getAccessToken, sendSingleMessage } from "../../src/util/dingtalk-api.js";

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
});

describe("DingTalkChannel.send", () => {
  beforeEach(() => {
    vi.mocked(getAccessToken).mockClear();
    vi.mocked(sendSingleMessage).mockClear();
  });

  it("查 recipient → 取 token → singleSend（robotCode/userIds 正确）", async () => {
    const ch = new DingTalkChannel({ appKey: "k", appSecret: "s", robotCode: "rc" });
    ch.recipients.set("cid", "staff1");
    await ch.send("cid", { text: "hi" });
    expect(getAccessToken).toHaveBeenCalledWith("k", "s");
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
