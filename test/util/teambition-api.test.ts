import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskComment,
  getAppAccessToken,
  resetTeambitionTokenCache,
  verifyWebhookSignature,
} from "../../src/util/teambition-api.js";

const CFG = { appKey: "tb-app", appSecret: "tb-secret", orgId: "org-1" };

afterEach(() => {
  resetTeambitionTokenCache();
  vi.unstubAllGlobals();
});

describe("verifyWebhookSignature（X-Signature = HMAC-SHA256(rawBody, appSecret) hex）", () => {
  const raw = JSON.stringify({ orgId: "org", event: "task.update", eventId: "e1" });

  it("正确签名放行（大小写不敏感）", () => {
    const sig = createHmac("sha256", CFG.appSecret).update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, CFG.appSecret, sig)).toBe(true);
    expect(verifyWebhookSignature(raw, CFG.appSecret, sig.toUpperCase())).toBe(true);
  });

  it("错误签名/密钥/缺失 → 拒绝（fail-closed）", () => {
    const sig = createHmac("sha256", "wrong").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, CFG.appSecret, sig)).toBe(false);
    expect(
      verifyWebhookSignature(
        raw + " ",
        CFG.appSecret,
        createHmac("sha256", CFG.appSecret).update(raw).digest("hex"),
      ),
    ).toBe(false);
    expect(verifyWebhookSignature(raw, CFG.appSecret, undefined)).toBe(false);
  });
});

describe("getAppAccessToken（本地 JWT 自签 HS256）", () => {
  it("payload 含 _appId/iat/exp 且签名可验", () => {
    const token = getAppAccessToken(CFG.appKey, CFG.appSecret, 1_700_000_000_000);
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as {
      _appId: string;
      iat: number;
      exp: number;
    };
    expect(payload._appId).toBe("tb-app");
    expect(payload.exp - payload.iat).toBe(3600);
    const expected = createHmac("sha256", CFG.appSecret).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });

  it("同 appId 缓存复用；不同 appId 各自独立", () => {
    const now = 1_700_000_000_000;
    const a1 = getAppAccessToken("app-a", "s1", now);
    expect(getAppAccessToken("app-a", "s1", now + 1000)).toBe(a1);
    const b1 = getAppAccessToken("app-b", "s2", now);
    expect(b1).not.toBe(a1);
  });
});

describe("createTaskComment（POST /api/v3/task/:taskId/comment）", () => {
  it("Bearer 自签 token + X-Tenant-Id/X-Tenant-Type 头 + content 体", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ dynamic: { id: "dyn-1" } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await createTaskComment(CFG, "task-9", "处理完成：xxx");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.teambition.com/api/v3/task/task-9/comment");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Tenant-Id"]).toBe("org-1");
    expect(headers["X-Tenant-Type"]).toBe("organization");
    expect(headers.Authorization).toMatch(/^Bearer ey/);
    expect(JSON.parse(init.body as string)).toEqual({ content: "处理完成：xxx" });
  });

  it("非 2xx 抛错（含状态码与响应片段）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"code":"x"}', { status: 403 })),
    );
    await expect(createTaskComment(CFG, "task-9", "hi")).rejects.toThrow(/403/);
  });
});
