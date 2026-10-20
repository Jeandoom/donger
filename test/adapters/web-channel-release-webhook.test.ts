import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createWakeFileWriter } from "../../src/domain/release-webhook.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 发布 webhook 路由 e2e（spec 2026-10-20-release-webhook-design §5.1/§11）：
 * POST /api/webhooks/release/:provider 全链——未装配/未配置 404、总闸 503、验签 403、
 * master push 唤醒文件落盘、非唤醒事件 202 静默、投递失败仍 202（轮询兜底）、限流 429。
 */

const SECRET = "wh-tok-e2e";
const MASTER_PUSH = JSON.stringify({ ref: "refs/heads/master", after: "a".repeat(40) });

let web: WebChannel;
let db: Database.Database;
let wakeDir: string;

async function startChannel(
  opts: { secrets?: Record<string, string>; disabled?: boolean; wakeDir?: string } = {},
): Promise<number> {
  db = new Database(":memory:");
  wakeDir = opts.wakeDir ?? mkdtempSync(join(tmpdir(), "release-wh-"));
  const sessionStore = new JwtSessionStore(db, "rel-wh-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: wakeDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const agentStore = new SqliteAgentStore(db, createSecretCipher("pw"));
  agentStore.migrate();
  const convStore = new SqliteConversationStore(db);
  convStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: wakeDir,
    sessionStore,
    userStore,
    feedbackStore,
    agentStore,
    conversationStore: convStore,
    workflowStore,
    ...(opts.secrets
      ? {
          releaseWebhook: {
            disabled: opts.disabled === true,
            secrets: opts.secrets,
            wake: createWakeFileWriter(wakeDir),
          },
        }
      : {}),
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function post(
  port: number,
  provider: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/webhooks/release/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function wakeFiles(): string[] {
  return readdirSync(wakeDir).filter((f) => f.startsWith("wake-"));
}

describe("POST /api/webhooks/release/:provider", () => {
  afterEach(async () => {
    await web.stop();
    db.close();
    rmSync(wakeDir, { recursive: true, force: true });
  });

  it("releaseWebhook 未装配 → 404；未知 provider → 404", async () => {
    const port = await startChannel();
    expect((await post(port, "gitee", MASTER_PUSH, { "x-gitee-token": SECRET })).status).toBe(404);

    const port2 = await startChannel({ secrets: { gitee: SECRET } });
    expect((await post(port2, "gitlab", MASTER_PUSH, { "x-gitee-token": SECRET })).status).toBe(
      404,
    );
    await web.stop();
  });

  it("总闸开启 → 503（轮询兜底不受影响）", async () => {
    const port = await startChannel({ secrets: { gitee: SECRET }, disabled: true });
    const res = await post(port, "gitee", MASTER_PUSH, { "x-gitee-token": SECRET });
    expect(res.status).toBe(503);
  });

  it("错 token → 403", async () => {
    const port = await startChannel({ secrets: { gitee: SECRET } });
    const res = await post(port, "gitee", MASTER_PUSH, { "x-gitee-token": "wrong" });
    expect(res.status).toBe(403);
  });

  it("绿路：gitee master push → 202 woke:true + 唤醒文件落盘（provider/event 可读）", async () => {
    const port = await startChannel({ secrets: { gitee: SECRET } });
    const res = await post(port, "gitee", MASTER_PUSH, {
      "x-gitee-token": SECRET,
      "x-gitee-event": "Push Hook",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ woke: true });
    const files = wakeFiles();
    expect(files).toHaveLength(1);
    const file = files[0];
    if (!file) throw new Error("wake file missing");
    const evt = JSON.parse(readFileSync(join(wakeDir, file), "utf8")) as {
      provider: string;
      event: string;
    };
    expect(evt.provider).toBe("gitee");
    expect(evt.event).toBe("push");
  });

  it("ping / 非 master 分支 → 202 woke:false 且不落盘", async () => {
    const port = await startChannel({ secrets: { gitee: SECRET } });
    const ping = await post(port, "gitee", "{}", {
      "x-gitee-token": SECRET,
      "x-gitee-event": "Ping Hook",
    });
    expect(ping.status).toBe(202);
    expect(await ping.json()).toEqual({ woke: false });
    const branch = await post(
      port,
      "gitee",
      JSON.stringify({ ref: "refs/heads/dev", after: "b".repeat(40) }),
      { "x-gitee-token": SECRET, "x-gitee-event": "Push Hook" },
    );
    expect(branch.status).toBe(202);
    expect(wakeFiles()).toHaveLength(0);
  });

  it("唤醒目录缺失 → 202 woke:false（投递失败不拖垮响应，轮询兜底）", async () => {
    const missing = join(tmpdir(), `wh-missing-${Date.now()}`, "no-such");
    const port = await startChannel({ secrets: { gitee: SECRET }, wakeDir: missing });
    const res = await post(port, "gitee", MASTER_PUSH, {
      "x-gitee-token": SECRET,
      "x-gitee-event": "Push Hook",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ woke: false, error: "wake delivery failed" });
  });

  it("限流：超出每分钟窗口 → 429", async () => {
    const port = await startChannel({ secrets: { gitee: SECRET } });
    let last = 0;
    for (let i = 0; i < 35; i++) {
      last = (
        await post(port, "gitee", "{}", { "x-gitee-token": SECRET, "x-gitee-event": "Ping Hook" })
      ).status;
    }
    expect(last).toBe(429);
  });
});
