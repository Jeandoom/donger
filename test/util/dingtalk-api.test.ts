import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSingleSendBody,
  getAccessToken,
  resetDingTalkTokenCache,
  sendSingleMessage,
} from "../../src/util/dingtalk-api.js";

beforeEach(() => {
  resetDingTalkTokenCache();
  vi.unstubAllGlobals();
});

describe("buildSingleSendBody", () => {
  it("text → SampleTextMessage + content", () => {
    const b = buildSingleSendBody("rc", "u1", { text: "hi" });
    expect(b).toEqual({
      robotCode: "rc",
      userIds: ["u1"],
      msgKey: "SampleTextMessage",
      msgParam: JSON.stringify({ content: "hi" }),
    });
  });

  it("markdown → SampleMarkdownMsg + title/text", () => {
    const b = buildSingleSendBody("rc", "u1", { text: "# 标题\n正文", markdown: true });
    expect(b.msgKey).toBe("SampleMarkdownMsg");
    expect(JSON.parse(b.msgParam)).toEqual({ title: "# 标题", text: "# 标题\n正文" });
  });
});

describe("getAccessToken", () => {
  it("首次拉取并缓存（第二次不再请求）", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "tok", expires_in: 7200 }),
    }));
    vi.stubGlobal("fetch", fn);
    expect(await getAccessToken("k", "s")).toBe("tok");
    expect(await getAccessToken("k", "s")).toBe("tok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gettoken 失败抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ errcode: 40001, errmsg: "invalid" }) })),
    );
    await expect(getAccessToken("k", "s")).rejects.toThrow(/gettoken 失败/);
  });
});

describe("sendSingleMessage", () => {
  it("POST 到 batchSend，带 token 头", async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", fn);
    await sendSingleMessage("tok", {
      robotCode: "rc",
      userIds: ["u1"],
      msgKey: "SampleTextMessage",
      msgParam: '{"content":"hi"}',
    });
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("oToMessages/batchSend"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "tok" }),
      }),
    );
  });

  it("非 2xx 抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad" })),
    );
    await expect(
      sendSingleMessage("tok", {
        robotCode: "rc",
        userIds: ["u1"],
        msgKey: "x",
        msgParam: "{}",
      }),
    ).rejects.toThrow(/singleSend 失败/);
  });
});
