import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteModelConfigStore } from "../../src/adapters/sqlite-model-config-store.js";
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

describe("用户 Models 配置 API", () => {
  it("读取默认配置、保存用户配置且不返回 key", async () => {
    db = new Database(":memory:");
    const userStore = new SqliteUserStore(db, {
      adminExternalIds: new Set(),
      usersDir: mkdtempSync(join(tmpdir(), "model-settings-users-")),
    });
    userStore.migrate();
    const user = await userStore.getOrCreateByIdentity("internal", "model-user", "模型用户");
    const sessionStore = new JwtSessionStore(db, "test-secret");
    sessionStore.migrate();
    const { token } = await sessionStore.create(user.id);
    const modelStore = new SqliteModelConfigStore(db, createSecretCipher("test-seed"));
    modelStore.migrate();

    web = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: mkdtempSync(join(tmpdir(), "model-settings-web-")),
      userStore,
      sessionStore,
      modelConfigStore: modelStore,
    });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("web server 未启动");

    const initial = await fetch(`http://127.0.0.1:${port}/api/settings/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(initial.status).toBe(503);

    const configuredWeb = new WebChannel({
      port: 0,
      host: "127.0.0.1",
      workspaceDir: mkdtempSync(join(tmpdir(), "model-settings-web-2-")),
      userStore,
      sessionStore,
      modelConfigStore: modelStore,
      llm: { model: "system", baseUrl: "https://system", authToken: "system-key" },
    });
    await web.stop();
    web = configuredWeb;
    configuredWeb.onMessage(() => {});
    await configuredWeb.ready();
    const configuredPort = configuredWeb.boundPort;
    if (!configuredPort) throw new Error("web server 未启动");

    const saved = await fetch(`http://127.0.0.1:${configuredPort}/api/settings/models`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://user-llm.example.com/anthropic",
        key: "user-key",
        models: ["claude-sonnet", "claude-haiku"],
        defaultModel: "claude-sonnet",
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      url: "https://user-llm.example.com/anthropic",
      models: ["claude-sonnet", "claude-haiku"],
      defaultModel: "claude-sonnet",
      keyConfigured: true,
    });
    expect(await modelStore.get(user.id)).toMatchObject({ key: "user-key" });
  });
});
