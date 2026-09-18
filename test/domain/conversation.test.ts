import { describe, expect, it } from "vitest";
import { ConversationSchema } from "../../src/domain/conversation.js";

describe("ConversationSchema", () => {
  it("校验合法 Conversation", () => {
    const c = ConversationSchema.parse({
      id: "c1",
      userId: "u1",
      sdkSessionId: "s1",
      title: "测试",
      channelId: "web",
      agentId: "",
      createdAt: "t",
      updatedAt: "t",
      archived: false,
    });
    expect(c.id).toBe("c1");
  });
  it("拒绝缺字段", () => {
    expect(() => ConversationSchema.parse({ id: "c1" })).toThrow();
  });
});
