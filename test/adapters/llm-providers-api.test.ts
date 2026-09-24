import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import type { LlmTestResult } from "../../src/adapters/llm-provider-tester.js";
import { SqliteLlmProviderStore } from "../../src/adapters/sqlite-llm-provider-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

let web: WebChannel | undefined;
let db: Database.Database | undefined;

afterEach(async () => {
  await web?.stop();
  db?.close();
  web = undefined;
  db = undefined;
});

async function startWeb(
  overrides: Partial<ConstructorParameters<typeof WebChannel>[0]> = {},
): Promise<{ port: number; token: string; store: SqliteLlmProviderStore; userId: string }> {
  db = db ?? new Database(":memory:");
  await web?.stop();
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: mkdtempSync(join(tmpdir(), "llm-providers-users-")),
  });
  userStore.migrate();
  const user = await userStore.getOrCreateByIdentity("internal", "llm-user", "模型用户");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const { token } = await sessionStore.create(user.id);
  const store = new SqliteLlmProviderStore(db, createSecretCipher("test-seed"));
  store.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: mkdtempSync(join(tmpdir(), "llm-providers-web-")),
    userStore,
    sessionStore,
    llmProviderStore: store,
    llm: { model: "glm-4.6", baseUrl: "https://open.bigmodel.cn/api/anthropic", authToken: "k" },
    ...overrides,
  });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("web server 未启动");
  return { port, token, store, userId: user.id };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("用户 LLM 供应商配置 API", () => {
  it("平台列表：包含双智谱且 custom 存在", async () => {
    const { port, token } = await startWeb();
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/llm-platforms`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { platforms: { id: string }[] };
    const ids = body.platforms.map((p) => p.id);
    expect(ids).toContain("zhipu-cn");
    expect(ids).toContain("zhipu-global");
    expect(ids).toContain("custom");
    // openai 协议平台（codex 引擎轮）
    expect(ids).toContain("openai");
  });

  it("CRUD 闭环：新建（脱敏）→ 列表 → 更新（key 留空保持）→ 删除", async () => {
    const { port, token, store, userId } = await startWeb();
    const created = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "我的智谱",
        platform: "zhipu-cn",
        key: "sk-secret",
        models: ["glm-4.6"],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.key).toBeUndefined();
    expect(createdBody.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    const id = createdBody.id as string;

    const listRes = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers`, {
      headers: authHeaders(token),
    });
    const listBody = (await listRes.json()) as {
      providers: unknown[];
      systemDefaultModel: string;
    };
    expect(listBody.providers).toHaveLength(1);
    expect(listBody.systemDefaultModel).toBe("glm-4.6");
    expect(JSON.stringify(listBody.providers)).not.toContain("sk-secret");

    const updated = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers/${id}`, {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "改名", models: ["glm-4.6", "glm-4.5"], isDefault: true }),
    });
    expect(updated.status).toBe(200);
    // key 未传 → 保持原值
    const withKey = await store.getWithKey(userId, id);
    expect(withKey?.key).toBe("sk-secret");
    expect(withKey?.isDefault).toBe(true);

    const removed = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers/${id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(removed.status).toBe(200);
    expect(await store.list(userId)).toHaveLength(0);
  });

  it("校验：custom 缺 baseUrl / 未知平台 / 新建缺 key 均被拒", async () => {
    const { port, token } = await startWeb();
    const post = async (payload: unknown): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.status;
    };
    expect(await post({ name: "x", platform: "custom", key: "k", models: ["m"] })).toBe(400);
    expect(await post({ name: "x", platform: "no-such", key: "k", models: ["m"] })).toBe(400);
    expect(await post({ name: "x", platform: "zhipu-cn", key: "", models: ["m"] })).toBe(400);
    expect(await post({ name: "x", platform: "zhipu-cn", key: "k", models: [] })).toBe(400);
  });

  it("test 端点：走注入的 tester 并限流", async () => {
    const calls: string[] = [];
    const { port, token } = await startWeb({
      llmProviderTester: {
        test: async (target) => {
          calls.push(target.model);
          const result: LlmTestResult = { ok: true, model: target.model };
          return result;
        },
      },
    });
    const created = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "DS",
        platform: "deepseek",
        key: "k",
        models: ["deepseek-chat"],
        isDefault: true,
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const first = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers/${id}/test`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, model: "deepseek-chat" });

    // 限流：60s 窗口 10 次，再打 9 次后第 10 次应 429
    let lastStatus = 200;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers/${id}/test`, {
        method: "POST",
        headers: authHeaders(token),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    expect(calls[0]).toBe("deepseek-chat");
  });

  it("未挂 store 时端点 503；未认证 401", async () => {
    const { port, token } = await startWeb();
    const anon = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers`);
    expect(anon.status).toBe(401);

    // 覆盖为不挂 store 的实例（同 db 重建最小实例，token 仍有效）
    await web?.stop();
    const currentDb = db;
    if (!currentDb) throw new Error("db 未初始化");
    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: mkdtempSync(join(tmpdir(), "llm-providers-web-bare-")),
      sessionStore: new JwtSessionStore(currentDb, "test-secret"),
    });
    web.onMessage(() => {});
    await web.ready();
    const barePort = web.boundPort;
    if (!barePort) throw new Error("bare web server 未启动");
    const noStore = await fetch(`http://127.0.0.1:${barePort}/api/settings/llm-providers`, {
      headers: authHeaders(token),
    });
    expect(noStore.status).toBe(503);
  });
});
