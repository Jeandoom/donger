import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSingleSendBody,
  getAccessToken,
  getUserAccessToken,
  getUserInfoByOAuth,
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
      msgKey: "sampleText",
      msgParam: JSON.stringify({ content: "hi" }),
    });
  });

  it("markdown → SampleMarkdownMsg + title/text", () => {
    const b = buildSingleSendBody("rc", "u1", { text: "# 标题\n正文", markdown: true });
    expect(b.msgKey).toBe("sampleMarkdownMsg");
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

describe("getUserAccessToken", () => {
  it("成功返回 token", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ accessToken: "oauth-tok", refreshToken: "refresh", expireIn: 7200 }),
    }));
    vi.stubGlobal("fetch", fn);
    const result = await getUserAccessToken("k", "s", "code123");
    expect(result.accessToken).toBe("oauth-tok");
    expect(result.refreshToken).toBe("refresh");
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("user_accessible_token"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("失败抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ errCode: 40001, errMsg: "bad code" }),
    })));
    await expect(getUserAccessToken("k", "s", "bad")).rejects.toThrow("钉钉 OAuth 失败");
  });
});

describe("getUserInfoByOAuth", () => {
  it("成功返回用户信息", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ userId: "staff123", name: "张三", avatar: "https://avatar.com/1" }),
    })));
    const info = await getUserInfoByOAuth("tok");
    expect(info.userId).toBe("staff123");
    expect(info.name).toBe("张三");
    expect(info.avatar).toBe("https://avatar.com/1");
  });

  it("失败抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ errCode: 40001, errMsg: "invalid token" }),
    })));
    await expect(getUserInfoByOAuth("bad")).rejects.toThrow("钉钉用户信息获取失败");
  });
});
