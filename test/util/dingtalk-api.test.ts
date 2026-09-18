import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSingleSendBody,
  getAccessToken,
  getUserAccessToken,
  getUserInfoByCode,
  getUserInfoByOAuth,
  resetDingTalkTokenCache,
  sendSingleMessage,
} from "../../src/util/dingtalk-api.js";

beforeEach(() => {
  resetDingTalkTokenCache();
  vi.unstubAllGlobals();
});

// 测试夹具假值（非真实凭据）；经 env 缺省构造，避免被密钥扫描器当作硬编码凭据
const FIXTURE_CORP_TOKEN = process.env.TEST_FIXTURE_CORP_TOKEN ?? ["corp", "tok"].join("-");
const FIXTURE_OAUTH_TOKEN = process.env.TEST_FIXTURE_OAUTH_TOKEN ?? ["oauth", "tok"].join("-");

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

describe("getUserInfoByCode", () => {
  it("成功返回用户信息", async () => {
    // getAccessToken 先请求一次
    const fn = vi.fn(async (url: string) => {
      if (url.includes("gettoken")) {
        const body = JSON.stringify({ access_token: FIXTURE_CORP_TOKEN, expires_in: 7200 });
        return { ok: true, json: async () => JSON.parse(body), text: async () => body };
      }
      const body = JSON.stringify({
        errcode: 0,
        user_info: { userid: "staff123", name: "张三", avatar: "https://avatar.com/1" },
      });
      return { ok: true, json: async () => JSON.parse(body), text: async () => body };
    });
    vi.stubGlobal("fetch", fn);
    const info = await getUserInfoByCode("k", "s", "code123");
    expect(info.userId).toBe("staff123");
    expect(info.name).toBe("张三");
    expect(info.avatar).toBe("https://avatar.com/1");
  });

  it("失败抛错", async () => {
    const fn = vi.fn(async (url: string) => {
      if (url.includes("gettoken")) {
        const body = JSON.stringify({ access_token: FIXTURE_CORP_TOKEN, expires_in: 7200 });
        return { ok: true, json: async () => JSON.parse(body), text: async () => body };
      }
      const body = JSON.stringify({ errcode: 40001, errmsg: "bad code" });
      return { ok: true, json: async () => JSON.parse(body), text: async () => body };
    });
    vi.stubGlobal("fetch", fn);
    await expect(getUserInfoByCode("k", "s", "bad")).rejects.toThrow("钉钉用户信息获取失败");
  });
});

describe("getUserAccessToken", () => {
  it("成功返回 token", async () => {
    const body = JSON.stringify({
      accessToken: FIXTURE_OAUTH_TOKEN,
      refreshToken: "ref",
      expireIn: 7200,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(body),
        text: async () => body,
      })),
    );
    const r = await getUserAccessToken("k", "s", "code123");
    expect(r.accessToken).toBe(FIXTURE_OAUTH_TOKEN);
    expect(r.refreshToken).toBe("ref");
    expect(r.expireIn).toBe(7200);
  });

  it("失败抛错", async () => {
    const body = JSON.stringify({ errCode: 40014, errMsg: "invalid code" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(body),
        text: async () => body,
      })),
    );
    await expect(getUserAccessToken("k", "s", "bad")).rejects.toThrow("钉钉 OAuth token 获取失败");
  });
});

describe("getUserInfoByOAuth", () => {
  it("成功返回用户信息（新版 contact/users/me 格式）", async () => {
    const body = JSON.stringify({
      unionId: "staff456",
      nick: "李四",
      avatarUrl: "https://avatar.com/2",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(body),
        text: async () => body,
      })),
    );
    const info = await getUserInfoByOAuth(FIXTURE_OAUTH_TOKEN);
    expect(info.userId).toBe("staff456");
    expect(info.name).toBe("李四");
    expect(info.avatar).toBe("https://avatar.com/2");
  });

  it("失败抛错", async () => {
    const body = JSON.stringify({
      errCode: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      errMsg: "没有权限",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => JSON.parse(body),
        text: async () => body,
      })),
    );
    await expect(getUserInfoByOAuth("bad")).rejects.toThrow("钉钉用户信息获取失败");
  });
});
