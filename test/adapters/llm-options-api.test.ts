import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteLlmProviderStore } from "../../src/adapters/sqlite-llm-provider-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { IncomingMessage } from "../../src/domain/types.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

let web: WebChannel | undefined;
let db: Database.Database | undefined;
let captured: IncomingMessage[] = [];

afterEach(async () => {
  await web?.stop();
  db?.close();
  web = undefined;
  db = undefined;
  captured = [];
});

interface SetupResult {
  port: number;
  token: string;
  conversationId: string;
  providerId: string;
  agentStore: SqliteAgentStore;
  agentId: string;
}

async function setup(
  opts: { agentModelRefs?: (providerId: string) => string[] } = {},
): Promise<SetupResult> {
  db = new Database(":memory:");
  const cipher = createSecretCipher("test-seed");
  const tmp = mkdtempSync(join(tmpdir(), "llm-options-"));
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: new Set(),
    usersDir: join(tmp, "users"),
  });
  userStore.migrate();
  const user = await userStore.getOrCreateByIdentity("internal", "llm-user", "用户");
  const sessionStore = new JwtSessionStore(db, "test-secret");
  sessionStore.migrate();
  const { token } = await sessionStore.create(user.id);
  const agentStore = new SqliteAgentStore(db, cipher);
  agentStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const providerStore = new SqliteLlmProviderStore(db, cipher);
  providerStore.migrate();
  const provider = await providerStore.create(user.id, {
    name: "我的智谱",
    platform: "zhipu-cn",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    key: "sk-1",
    models: ["glm-4.6", "glm-4.5"],
    sdkType: "anthropic",
    isDefault: true,
  });
  const agent = await agentStore.create({
    ownerId: user.id,
    name: "A",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    gitRepositories: [],
    extensionDirectories: [],
    llm: opts.agentModelRefs ? { modelRefs: opts.agentModelRefs(provider.id) } : {},
  } as never);
  const conversation = await conversationStore.createWithAgent(
    user.id,
    "web",
    "测试会话",
    agent.id,
  );
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: join(tmp, "web"),
    userStore,
    sessionStore,
    conversationStore,
    agentStore,
    llmProviderStore: providerStore,
    llm: { model: "glm-4.6", baseUrl: "https://sys", authToken: "sys-key" },
    agentMeta: {
      presets: [{ id: "0", name: "P", model: "glm-4.6", baseUrl: "https://sys" }],
      skillPaths: [],
    },
  });
  web.onMessage((m) => captured.push(m));
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("web server 未启动");
  return {
    port,
    token,
    conversationId: conversation.id,
    providerId: provider.id,
    agentStore,
    agentId: agent.id,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("会话 LLM 选择 API（M2）", () => {
  it("llm-options：agent 未配置范围 → 全量（system+presets+我的配置）", async () => {
    const { port, token, conversationId, providerId } = await setup();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${conversationId}/llm-options`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { ref: string }[];
      restricted: boolean;
      current: string;
    };
    expect(body.restricted).toBe(false);
    expect(body.options.map((o) => o.ref)).toEqual([
      "system",
      "preset:0",
      `provider:${providerId}:glm-4.6`,
      `provider:${providerId}:glm-4.5`,
    ]);
    expect(body.current).toBe("");
  });

  it("llm-options：agent 配置范围 → restricted 且过滤降级（他人 provider 引用剔除）", async () => {
    const { port, token, conversationId, providerId } = await setup({
      agentModelRefs: (pid) => [`provider:${pid}:glm-4.6`, "provider:not-mine:m"],
    });
    const res = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${conversationId}/llm-options`,
      { headers: authHeaders(token) },
    );
    const body = (await res.json()) as { options: { ref: string }[]; restricted: boolean };
    expect(body.restricted).toBe(true);
    expect(body.options.map((o) => o.ref)).toEqual([`provider:${providerId}:glm-4.6`]);
  });

  it("POST messages 携带 modelRef → 透传 handler；非法格式 400", async () => {
    const { port, token, conversationId, providerId } = await setup();
    const ok = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", modelRef: `provider:${providerId}:glm-4.6` }),
      },
    );
    expect(ok.status).toBe(202);
    expect(captured[0]?.modelRef).toBe(`provider:${providerId}:glm-4.6`);

    const bad = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", modelRef: "not-a-ref" }),
      },
    );
    expect(bad.status).toBe(400);
  });

  it("DELETE provider 被 agent.modelRefs 引用 → 400；解除引用后可删", async () => {
    const { port, token, providerId, agentStore, agentId } = await setup({
      agentModelRefs: (pid) => [`provider:${pid}:glm-4.6`],
    });
    const blocked = await fetch(
      `http://127.0.0.1:${port}/api/settings/llm-providers/${providerId}`,
      { method: "DELETE", headers: authHeaders(token) },
    );
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("仍在引用") });

    // 解除引用后删除成功
    await agentStore.update(agentId, { llm: {} } as never);
    const freed = await fetch(`http://127.0.0.1:${port}/api/settings/llm-providers/${providerId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(freed.status).toBe(200);
  });
});
