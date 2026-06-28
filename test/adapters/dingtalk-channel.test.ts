import type { RobotTextMessage } from "dingtalk-stream";
import { describe, expect, it } from "vitest";
import { normalizeDingTalkMessage } from "../../src/adapters/dingtalk-channel.js";

const base: RobotTextMessage = {
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
  it("归一为 IncomingMessage（channelId/threadId/requesterId/text 去空格）", () => {
    expect(normalizeDingTalkMessage(base)).toEqual({
      channelId: "dingtalk",
      threadId: "cid-1",
      requesterId: "staff-1",
      text: "做某事",
    });
  });

  it("content 为空串时 text 为空", () => {
    const m = normalizeDingTalkMessage({ ...base, text: { content: "" } });
    expect(m.text).toBe("");
  });
});
