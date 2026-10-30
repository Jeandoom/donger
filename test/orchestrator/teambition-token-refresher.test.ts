import { describe, expect, it, vi } from "vitest";
import {
  refreshTeambitionTokensOnce,
  TB_CREDENTIAL_CODE,
} from "../../src/orchestrator/teambition-token-refresher.js";

const TOKEN_URL = "https://account.teambition.com/oauth2/mcp/token";

function fakeStore(users: Array<{ userId: string; values?: Record<string, string> }>) {
  const upserts: Array<{ userId: string; values: Record<string, string> }> = [];
  return {
    upserts,
    store: {
      listUserIdsWithValue: async (code: string) =>
        users.some((u) => u.values) && code === TB_CREDENTIAL_CODE
          ? users.map((u) => u.userId)
          : [],
      getFilledValues: async (userId: string, codes: string[]) =>
        codes.includes(TB_CREDENTIAL_CODE)
          ? users
              .filter((u) => u.userId === userId && u.values)
              .map((u) => ({ code: TB_CREDENTIAL_CODE, values: u.values! }))
          : [],
      upsertValue: async (userId: string, code: string, values: Record<string, string>) => {
        upserts.push({ userId, values });
      },
    },
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("refreshTeambitionTokensOnce", () => {
  it("刷新成功：TOKEN/REFRESH_TOKEN 轮换回写（CLIENT_ID 保留）", async () => {
    const { store, upserts } = fakeStore([
      {
        userId: "u1",
        values: { TOKEN: "old", REFRESH_TOKEN: "rt-old", CLIENT_ID: "dcr_x" },
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ access_token: "new-a", refresh_token: "rt-new", expires_in: 3600 }),
    );
    const out = await refreshTeambitionTokensOnce(
      { credentialSets: store as never, logger: logger as never },
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=rt-old");
    expect(upserts).toEqual([
      {
        userId: "u1",
        values: { TOKEN: "new-a", REFRESH_TOKEN: "rt-new", CLIENT_ID: "dcr_x" },
      },
    ]);
  });

  it("无 REFRESH_TOKEN/CLIENT_ID 的用户跳过；刷新失败计 failed 不回写", async () => {
    const { store, upserts } = fakeStore([
      { userId: "u-skip", values: { TOKEN: "only" } },
      { userId: "u-fail", values: { TOKEN: "old", REFRESH_TOKEN: "rt", CLIENT_ID: "c" } },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    const out = await refreshTeambitionTokensOnce(
      { credentialSets: store as never, logger: logger as never },
      fetchMock as unknown as typeof fetch,
    );
    expect(out).toEqual({ refreshed: 0, skipped: 1, failed: 1 });
    expect(upserts).toEqual([]);
  });
});
