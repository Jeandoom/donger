import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { DingTalkNotificationAdapter } from "../../src/adapters/notif-dingtalk.js";
import { WebhookNotificationAdapter } from "../../src/adapters/notif-webhook.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteNotificationStore } from "../../src/adapters/sqlite-notification-store.js";
import { SqliteTriggerQueueStore } from "../../src/adapters/sqlite-trigger-queue-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { LoopRunner } from "../../src/orchestrator/loop-runner.js";
import { NotificationService } from "../../src/orchestrator/notification-service.js";
import type {
  NotificationChannelAdapter,
  OutboundNotification,
} from "../../src/ports/notification-channel.js";
import { resetDingTalkTokenCache } from "../../src/util/dingtalk-api.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";
import { createTestModuleConfigStore } from "../util/module-config-test-helper.js";

const logger = pino({ level: "silent" });
const realFetch = globalThis.fetch;

/** 通知内核契约测试（spec 2026-09-28-notification-module-design §4/§7/§9）。 */

describe("NotificationService 内核", () => {
  it("未登记事件 fail-closed 拒发", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    const svc = new NotificationService({ store });
    await expect(
      svc.notify({
        event: "totally.bogus" as never,
        recipients: [{ kind: "user", userId: "u1" }],
        title: "x",
        body: "y",
      }),
    ).rejects.toThrow(/未登记的通知事件/);
    expect(await svc.unreadCount("u1")).toBe(0);
    db.close();
  });

  it("落库/列表/未读/已读全链路；dedupeKey 幂等（同键只落一条）", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    const svc = new NotificationService({ store });
    await svc.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "任务完成",
      body: "ok",
      dedupeKey: "task:t1:completed",
    });
    // 同 dedupeKey 重发 → 不重复
    await svc.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "任务完成",
      body: "ok",
      dedupeKey: "task:t1:completed",
    });
    expect(await svc.unreadCount("u1")).toBe(1);

    const list = await svc.list("u1", { limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.title).toBe("任务完成");

    const id = list.items[0]?.id ?? "";
    expect(await svc.markRead("u1", id)).toBe(true);
    expect(await svc.unreadCount("u1")).toBe(0);
    // 已读再标 → false；他人 id 不可读（属主过滤）
    expect(await svc.markRead("u1", id)).toBe(false);
    expect(await svc.markRead("u2", id)).toBe(false);
    expect(await svc.markAllRead("u1")).toBe(0);
    db.close();
  });

  it("订阅偏好：关闭组不再投递；强制组（账号安全）锁定开且 setPref 拒绝", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    const svc = new NotificationService({ store });

    // 关闭 task 组站内信
    expect(await svc.setPref("u1", { eventGroup: "task", channel: "inapp", enabled: false })).toBe(
      true,
    );
    await svc.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
    });
    expect(await svc.unreadCount("u1")).toBe(0);

    // system 组关闭后：credential.missing 不投，eviction.notice（mandatory）仍投
    await svc.setPref("u1", { eventGroup: "system", channel: "inapp", enabled: false });
    await svc.notify({
      event: "credential.missing",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
    });
    await svc.notify({
      event: "eviction.notice",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
    });
    expect(await svc.unreadCount("u1")).toBe(1);

    // account 组强制：setPref 拒绝；user.role_changed 即便偏好表被旁路改关也仍投递
    expect(
      await svc.setPref("u1", { eventGroup: "account", channel: "inapp", enabled: false }),
    ).toBe(false);
    await svc.setPref("u1", { eventGroup: "account", channel: "inapp", enabled: true });
    await svc.notify({
      event: "user.role_changed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
    });
    expect(await svc.unreadCount("u1")).toBe(2);
    db.close();
  });

  it("未读上限频控：达上限后丢弃新通知", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    const svc = new NotificationService({ store, maxUnreadPerUser: 2 });
    for (let i = 0; i < 5; i++) {
      await svc.notify({
        event: "feedback.replied",
        recipients: [{ kind: "user", userId: "u1" }],
        title: `n${i}`,
        body: "b",
        dedupeKey: `k${i}`,
      });
    }
    expect(await svc.unreadCount("u1")).toBe(2);
    db.close();
  });
});

// ===== Web API（守卫 + 属主过滤 + 偏好矩阵）=====

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let notificationService: NotificationService;

async function startChannel(opts?: {
  adapters?: NotificationChannelAdapter[];
  retryDelaysMs?: number[];
}): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "notif-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const notificationStore = new SqliteNotificationStore(db, createSecretCipher("notif-test-seed"));
  notificationStore.migrate();
  notificationService = new NotificationService({
    store: notificationStore,
    adapters: opts?.adapters,
    getIdentities: (userId) => userStore.getIdentities(userId),
    retryDelaysMs: opts?.retryDelaysMs ?? [0, 0],
  });
  const feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    moduleConfigStore: createTestModuleConfigStore(db, { signupAllowedDomains: ["example.com"] }),
    notificationService,
    feedbackStore,
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

function get(port: number, path: string, token?: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: "manual",
  });
}

function post(port: number, path: string, body: unknown, token: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function put(port: number, path: string, body: unknown, token: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function del(port: number, path: string, token: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function tokenFor(name: string): Promise<string> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
  const { token } = await sessionStore.create(user.id);
  return token;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "notif-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "notif-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("通知 Web API", () => {
  it("未登录 401；列表属主过滤；已读/未读数/全部已读闭环", async () => {
    const port = await startChannel();
    const anon = await get(port, "/api/notifications");
    expect(anon.status).toBe(401);

    const tokenA = await tokenFor("alice");
    const tokenB = await tokenFor("bob");
    const aliceId = (await userStore.getOrCreateByIdentity("test", "alice", "alice")).id;
    const bobId = (await userStore.getOrCreateByIdentity("test", "bob", "bob")).id;
    await notificationService.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: aliceId }],
      title: "A1",
      body: "b",
      dedupeKey: "a1",
    });
    await notificationService.notify({
      event: "loop.run_failed",
      recipients: [{ kind: "user", userId: aliceId }],
      title: "A2",
      body: "b",
      dedupeKey: "a2",
    });
    await notificationService.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: bobId }],
      title: "B1",
      body: "b",
      dedupeKey: "b1",
    });

    const listA = (await (await get(port, "/api/notifications", tokenA)).json()) as {
      total: number;
      unread: number;
      items: Array<{ id: string; title: string; readAt?: string }>;
    };
    expect(listA.total).toBe(2);
    expect(listA.unread).toBe(2);
    expect(listA.items.map((i) => i.title).sort()).toEqual(["A1", "A2"]);

    const listB = (await (await get(port, "/api/notifications", tokenB)).json()) as {
      total: number;
    };
    expect(listB.total).toBe(1);

    const unread = (await (await get(port, "/api/notifications/unread-count", tokenA)).json()) as {
      count: number;
    };
    expect(unread.count).toBe(2);

    // B 不可读 A 的通知（属主过滤）；已读后不可重复读
    const aFirst = listA.items[0]?.id ?? "";
    expect((await post(port, "/api/notifications/read", { id: aFirst }, tokenB)).status).toBe(404);
    expect((await post(port, "/api/notifications/read", { id: aFirst }, tokenA)).status).toBe(200);
    expect((await post(port, "/api/notifications/read", { id: aFirst }, tokenA)).status).toBe(404);
    const after = (await (await get(port, "/api/notifications/unread-count", tokenA)).json()) as {
      count: number;
    };
    expect(after.count).toBe(1);

    const markAll = await post(port, "/api/notifications/read", { all: true }, tokenA);
    expect(markAll.status).toBe(200);
    const final = (await (await get(port, "/api/notifications/unread-count", tokenA)).json()) as {
      count: number;
    };
    expect(final.count).toBe(0);
  });

  it("订阅偏好：矩阵含强制组；账号安全关 409；任务组关后不再投递", async () => {
    const port = await startChannel();
    const token = await tokenFor("carol");
    const carolId = (await userStore.getOrCreateByIdentity("test", "carol", "carol")).id;

    const prefsRes = await get(port, "/api/notifications/prefs", token);
    expect(prefsRes.status).toBe(200);
    const { groups } = (await prefsRes.json()) as {
      groups: Array<{
        eventGroup: string;
        mandatory: boolean;
        channels: { inapp: boolean; dingtalk: boolean; webhook: boolean };
      }>;
    };
    expect(groups.map((g) => g.eventGroup)).toEqual([
      "task",
      "loop",
      "system",
      "account",
      "feedback",
    ]);
    const account = groups.find((g) => g.eventGroup === "account");
    expect(account?.mandatory).toBe(true);
    expect(account?.channels.inapp).toBe(true);
    // 站外通道 opt-in：缺省全关
    expect(account?.channels.dingtalk).toBe(false);
    expect(account?.channels.webhook).toBe(false);

    const deny = await put(
      port,
      "/api/notifications/prefs",
      { eventGroup: "account", channel: "inapp", enabled: false },
      token,
    );
    expect(deny.status).toBe(409);
    const bad = await put(
      port,
      "/api/notifications/prefs",
      { eventGroup: "nope", channel: "inapp", enabled: true },
      token,
    );
    expect(bad.status).toBe(400);

    await put(
      port,
      "/api/notifications/prefs",
      { eventGroup: "task", channel: "inapp", enabled: false },
      token,
    );
    await notificationService.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: carolId }],
      title: "x",
      body: "y",
      dedupeKey: "c1",
    });
    expect(await notificationService.unreadCount(carolId)).toBe(0);

    const after = (await (await get(port, "/api/notifications/prefs", token)).json()) as {
      groups: Array<{ eventGroup: string; channels: { inapp: boolean } }>;
    };
    expect(after.groups.find((g) => g.eventGroup === "task")?.channels.inapp).toBe(false);

    // 站外通道偏好可开（dingtalk/webhook 非强制组约束）
    const out = await put(
      port,
      "/api/notifications/prefs",
      { eventGroup: "loop", channel: "webhook", enabled: true },
      token,
    );
    expect(out.status).toBe(200);
  });

  it("反馈回复 → 提交者收站内信带 focus 深链；时间线/详情带姓名", async () => {
    const port = await startChannel();
    const aliceToken = await tokenFor("alice");
    const adminToken = await tokenFor("rootadmin");
    await userStore.updateRole(
      (await userStore.getOrCreateByIdentity("test", "rootadmin", "rootadmin")).id,
      "admin",
    );

    const created = await post(port, "/api/feedback", { content: "搜索页报错" }, aliceToken);
    expect(created.status).toBe(201);
    const fb = (await created.json()) as { id: string };

    const replied = await post(
      port,
      `/api/feedback/${fb.id}/replies`,
      { content: "已定位，明天修复" },
      adminToken,
    );
    expect(replied.status).toBe(201);
    // notify 是 fire-and-forget：跨宏任务边界等异步落库完成
    await new Promise((resolve) => setImmediate(resolve));
    const list = (await (await get(port, "/api/notifications", aliceToken)).json()) as {
      items: Array<{ event: string; link?: string }>;
    };
    const fbNotice = list.items.find((n) => n.event === "feedback.replied");
    // 详情深链：通知「详情」按钮直达该反馈的对话（FeedbackPage ?focus=）
    expect(fbNotice?.link).toBe(`/feedback?focus=${fb.id}`);

    // 对话视图姓名补齐：回复带 authorName、详情带提交人 userName
    const timeline = (
      (await (await get(port, `/api/feedback/${fb.id}/replies`, aliceToken)).json()) as {
        replies: Array<{ authorName?: string }>;
      }
    ).replies;
    expect(timeline[0]?.authorName).toBe("rootadmin");
    const detail = (await (await get(port, `/api/feedback/${fb.id}`, adminToken)).json()) as {
      userName?: string;
    };
    expect(detail.userName).toBe("alice");
  });
});

// ===== loop-runner 发出点（无人值守结果 → 站内信）=====

function setupLoopRunner(handleMessage: (msg: unknown) => Promise<string | undefined>) {
  const db = new Database(":memory:");
  const triggerStore = new SqliteTriggerStore(db);
  triggerStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const loopStore = new SqliteLoopStore(db);
  loopStore.migrate();
  const notificationStore = new SqliteNotificationStore(db);
  notificationStore.migrate();
  const notifications = new NotificationService({ store: notificationStore });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "loop-notify-"));
  const queue = new SqliteTriggerQueueStore(db);
  queue.migrate();
  const runner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator: { handleMessage },
    workspaceRoot,
    channelId: "web",
    logger,
    queue,
    notifications,
  });
  return { db, triggerStore, workflowStore, loopStore, notifications, runner, workspaceRoot };
}

describe("LoopRunner 通知收编", () => {
  it("运行成功 → loop.run_succeeded 站内信（属主收件，带 loop 深链）", async () => {
    const s = setupLoopRunner(vi.fn().mockResolvedValue("conv-1"));
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/n1",
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
      promptTemplate: "do: {{triggerOutput}}",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.runner.fire(l.id, "hello");
    // notify 是 fire-and-forget：跨宏任务边界等异步落库完成
    await new Promise((resolve) => setImmediate(resolve));
    const list = await s.notifications.list("u1", { limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.event).toBe("loop.run_succeeded");
    expect(list.items[0]?.link).toBe(`/loops/${l.id}`);
    s.db.close();
    rmSync(s.workspaceRoot, { recursive: true, force: true });
  });

  it("运行失败 → loop.run_failed 站内信（critical）", async () => {
    const s = setupLoopRunner(vi.fn().mockRejectedValue(new Error("boom")));
    const t = await s.triggerStore.create({
      ownerId: "u1",
      name: "T",
      type: "hook",
      hook: {
        path: "/hooks/n2",
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    const w = await s.workflowStore.create({
      ownerId: "u1",
      name: "W",
      triggerId: t.id,
      agentId: "a1",
      promptTemplate: "do",
    });
    const l = await s.loopStore.create({ ownerId: "u1", name: "L", workflowId: w.id });
    await s.runner.fire(l.id, "hello");
    await new Promise((resolve) => setImmediate(resolve));
    const list = await s.notifications.list("u1", { limit: 10, offset: 0 });
    expect(list.items[0]?.event).toBe("loop.run_failed");
    expect(list.items[0]?.severity).toBe("critical");
    expect(list.items[0]?.body).toContain("boom");
    s.db.close();
    rmSync(s.workspaceRoot, { recursive: true, force: true });
  });
});

// ===== M2：webhook 出站适配器（SSRF/签名/重定向复判/响应不回显）=====

function fetchMock(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = (init ?? {}) as RequestInit;
    calls.push({ url, init: req });
    return handler(url, req);
  }) as typeof fetch;
  return { impl, calls };
}

const sampleNotice: OutboundNotification = {
  id: "n-1",
  event: "loop.run_failed",
  severity: "critical",
  title: "t",
  body: "b",
};

describe("WebhookNotificationAdapter", () => {
  it("内网/环回目标被 SSRF 守卫拒绝，且不发起请求", async () => {
    const { impl, calls } = fetchMock(() => new Response("x", { status: 200 }));
    const adapter = new WebhookNotificationAdapter({ fetchImpl: impl });
    const outcome = await adapter.send("http://127.0.0.1:9100/hook", sampleNotice);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("安全守卫");
    expect(calls).toHaveLength(0);
  });

  it("公网目标投递成功并携带幂等头与 HMAC 签名", async () => {
    const { impl, calls } = fetchMock(() => new Response("should-not-leak", { status: 200 }));
    const adapter = new WebhookNotificationAdapter({ fetchImpl: impl });
    const outcome = await adapter.send("https://example.com/hook", sampleNotice, {
      secret: "s3cret",
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Donger-Notification-Id"]).toBe("n-1");
    expect(headers["X-Donger-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["X-Donger-Timestamp"]).toBeTruthy();
  });

  it("重定向跳内网被复判拦截；失败状态不回显响应体", async () => {
    // 302 → 内网：第二跳深校验拒绝
    const { impl: impl1 } = fetchMock(
      () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/hook" } }),
    );
    const adapter1 = new WebhookNotificationAdapter({ fetchImpl: impl1 });
    const out1 = await adapter1.send("https://example.com/hook", sampleNotice);
    expect(out1.ok).toBe(false);
    expect(out1.error).toContain("安全守卫");

    // 500：错误仅含状态码，不回显响应体
    const { impl: impl2 } = fetchMock(
      () => new Response("internal-target-list 192.168.1.1", { status: 500 }),
    );
    const adapter2 = new WebhookNotificationAdapter({ fetchImpl: impl2 });
    const out2 = await adapter2.send("https://example.com/hook", sampleNotice);
    expect(out2.ok).toBe(false);
    expect(out2.error).toBe("HTTP 500");
    expect(JSON.stringify(out2)).not.toContain("192.168.1.1");
  });
});

// ===== M2：站外分发管线（opt-in 偏好/地址解析/跳过/重试/投递日志）=====

function fakeAdapter(id: "dingtalk" | "webhook") {
  const calls: Array<{ address: string; n: OutboundNotification; opts: unknown }> = [];
  const texts: Array<{ address: string; text: string }> = [];
  const adapter: NotificationChannelAdapter = {
    id,
    available: () => true,
    send: async (address, n, opts) => {
      calls.push({ address, n, opts });
      return { ok: true };
    },
    sendText: async (address, text) => {
      texts.push({ address, text });
      return { ok: true };
    },
  };
  return { adapter, calls, texts };
}

const flushMs = () => new Promise((r) => setTimeout(r, 20));

describe("NotificationService 站外分发", () => {
  it("opt-in 管线：未订阅不投；订阅无地址 skipped；保存地址后投递成功", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db, createSecretCipher("seed-m2"));
    store.migrate();
    const { adapter, calls } = fakeAdapter("webhook");
    const svc = new NotificationService({ store, adapters: [adapter], retryDelaysMs: [0, 0] });

    // 未订阅：不发起投递
    await svc.notify({
      event: "task.completed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
      dedupeKey: "k0",
    });
    await flushMs();
    expect(calls).toHaveLength(0);

    // 订阅 loop 组 webhook 但未绑地址 → skipped
    await svc.setPref("u1", { eventGroup: "loop", channel: "webhook", enabled: true });
    await svc.notify({
      event: "loop.run_failed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
      dedupeKey: "k1",
    });
    await flushMs();
    expect(calls).toHaveLength(0);
    let deliveries = await svc.listDeliveries(10);
    expect(deliveries[0]?.status).toBe("skipped");
    expect(deliveries[0]?.error).toContain("未绑定投递地址");

    // 保存 webhook 地址（fake adapter 直接成功）→ 投递 ok + 携带签名密钥
    const saved = await svc.saveWebhookAddress("u1", { url: "https://example.com/hook" }, {});
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.probe.reachable).toBe(true);
    await svc.notify({
      event: "loop.run_failed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t2",
      body: "b2",
      dedupeKey: "k2",
    });
    await flushMs();
    // calls = 保存探测 1 次 + 通知分发 1 次
    expect(calls).toHaveLength(2);
    expect(calls[1]?.address).toBe("https://example.com/hook");
    expect((calls[1]?.opts as { secret?: string }).secret).toBeTruthy();
    deliveries = await svc.listDeliveries(10);
    expect(deliveries[0]?.status).toBe("ok");
    expect(deliveries[0]?.channel).toBe("webhook");
    expect(deliveries[0]?.event).toBe("loop.run_failed");
    db.close();
  });

  it("投递失败按退避重试，最终成功记录 attempts", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    let attempts = 0;
    const flaky: NotificationChannelAdapter = {
      id: "webhook",
      available: () => true,
      send: async () => {
        attempts += 1;
        return attempts < 3 ? { ok: false, error: "boom" } : { ok: true };
      },
    };
    const svc = new NotificationService({ store, adapters: [flaky], retryDelaysMs: [0, 0] });
    await svc.setPref("u1", { eventGroup: "task", channel: "webhook", enabled: true });
    await svc.saveWebhookAddress("u1", { url: "https://example.com/hook" }, {});
    await svc.notify({
      event: "task.failed",
      recipients: [{ kind: "user", userId: "u1" }],
      title: "t",
      body: "b",
    });
    await flushMs();
    expect(attempts).toBe(3);
    const deliveries = await svc.listDeliveries(5);
    expect(deliveries[0]?.status).toBe("ok");
    // attempts 只计分发循环自身次数（保存探活的一次不计入）
    expect(deliveries[0]?.attempts).toBe(2);
    db.close();
  });

  it("钉钉验证码闭环：发码→错码拒→对码绑定；他人重复认领 409", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNotificationStore(db);
    store.migrate();
    const { adapter } = fakeAdapter("dingtalk");
    const svc = new NotificationService({ store, adapters: [adapter], retryDelaysMs: [0, 0] });

    const req = await svc.requestDingTalkVerify("u1", "staff-1");
    expect(req.ok).toBe(true);
    // 未验证的手填地址不参与投递解析（白盒：服务内私有解析器）
    const resolver = svc["resolveOutboundAddress"].bind(svc);
    expect(await resolver("u1", "dingtalk")).toBeUndefined();

    const wrong = await svc.confirmDingTalkVerify("u1", "000000");
    expect(wrong.ok).toBe(false);

    // 白盒取 pending 真码完成绑定（测试专用路径）
    const pending = svc["dingTalkVerifyPending"].get("u1");
    expect(pending).toBeTruthy();
    const confirm = await svc.confirmDingTalkVerify("u1", pending?.code ?? "");
    expect(confirm.ok).toBe(true);
    const addr = await svc.getAddress("u1", "dingtalk");
    expect(addr?.address).toBe("staff-1");
    expect(addr?.verifiedAt).toBeTruthy();

    // 他人认领已验证地址 → 409
    const dup = await svc.requestDingTalkVerify("u2", "staff-1");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.status).toBe(409);
    db.close();
  });
});

// ===== M2：Web API（地址簿/验证/测试/admin 投递日志与公告）=====

describe("通知 M2 Web API", () => {
  it("webhook 保存/回显/删除全链路；内网 URL 保存被拒", async () => {
    const { adapter, calls } = fakeAdapter("webhook");
    const port = await startChannel({ adapters: [adapter] });
    const token = await tokenFor("hooker");

    const denied = await put(
      port,
      "/api/notifications/addresses/webhook",
      { url: "http://169.254.169.254/latest" },
      token,
    );
    expect(denied.status).toBe(400);

    const saved = await put(
      port,
      "/api/notifications/addresses/webhook",
      { url: "https://example.com/hook", headers: { "X-Token": "v" } },
      token,
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { probe: { reachable: boolean } };
    expect(savedBody.probe.reachable).toBe(true);

    const view = (await (await get(port, "/api/notifications/addresses", token)).json()) as {
      webhook: { url: string; secret: string | null; headerKeys: string[] } | null;
      dingtalk: { source: string | null };
    };
    expect(view.webhook?.url).toBe("https://example.com/hook");
    expect(view.webhook?.secret).toBeTruthy();
    expect(view.webhook?.headerKeys).toEqual(["X-Token"]);
    expect(view.dingtalk.source).toBeNull();

    // 测试发送 + 删除
    const testRes = await post(port, "/api/notifications/addresses/webhook/test", {}, token);
    expect(testRes.status).toBe(200);
    const delRes = await del(port, "/api/notifications/addresses/webhook", token);
    expect(delRes.status).toBe(200);
    const after = (await (await get(port, "/api/notifications/addresses", token)).json()) as {
      webhook: unknown;
    };
    expect(after.webhook).toBeNull();
    // 保存探测 1 次 + 测试发送 1 次
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("admin 专属：投递日志/公告群发；非 admin 403", async () => {
    const { adapter } = fakeAdapter("dingtalk");
    const port = await startChannel({ adapters: [adapter] });
    const user = await tokenFor("dave");
    const admin = await tokenFor("root");
    await userStore.updateRole(
      (await userStore.getOrCreateByIdentity("test", "root", "root")).id,
      "admin",
    );

    const forbidden = await get(port, "/api/admin/notifications/deliveries", user);
    expect(forbidden.status).toBe(403);

    const ann = await post(
      port,
      "/api/admin/notifications/announcement",
      { title: "维护通知", body: "今晚升级", severity: "warn" },
      admin,
    );
    expect(ann.status).toBe(200);
    const annBody = (await ann.json()) as { recipients: number };
    expect(annBody.recipients).toBeGreaterThanOrEqual(2);
    // 公告以站内信触达订阅者（system 组站内默认开）
    const daveNotifs = (await (await get(port, "/api/notifications", user)).json()) as {
      items: Array<{ title: string }>;
    };
    expect(daveNotifs.items.some((n) => n.title === "维护通知")).toBe(true);

    const deliveries = await get(port, "/api/admin/notifications/deliveries", admin);
    expect(deliveries.status).toBe(200);
    const status = await get(port, "/api/admin/notifications/status", admin);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { channels: Record<string, boolean> };
    expect(statusBody.channels.inapp).toBe(true);
    expect(statusBody.channels.dingtalk).toBe(true);
  });
});

// ===== M2.1：钉钉地址标识换算（unionId→staffId，生产 staffId.notExisted 修复）=====

function dingtalkFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, body });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("DingTalkNotificationAdapter 地址标识换算", () => {
  it("unionId 地址先经 getbyunionid 换算为 staffId 再投递", async () => {
    resetDingTalkTokenCache();
    const cfg = { appKey: "ak", appSecret: "sk", robotCode: "rb" };
    const adapter = new DingTalkNotificationAdapter(() => cfg);
    const { impl, calls } = dingtalkFetchMock((url) => {
      if (url.includes("gettoken")) {
        return Response.json({ access_token: "corp-token", expires_in: 7200 });
      }
      if (url.includes("getbyunionid")) {
        return Response.json({ errcode: 0, result: { userid: "staff-001" } });
      }
      return Response.json({}, { status: 200 });
    });
    // 替换模块内 fetch：适配器与 util 同进程共享 globalThis.fetch
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const outcome = await adapter.sendText("union-abc", "测试");
      expect(outcome.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const unionCall = calls.find((c) => c.url.includes("getbyunionid"));
    expect(unionCall?.body).toEqual({ unionid: "union-abc" });
    const sendCall = calls.find((c) => c.url.includes("oToMessages"));
    expect((sendCall?.body as { userIds: string[] }).userIds).toEqual(["staff-001"]);
  });

  it("staffId 地址换算查无时回落原地址直投（负缓存防误判固化）", async () => {
    resetDingTalkTokenCache();
    const cfg = { appKey: "ak", appSecret: "sk", robotCode: "rb" };
    const adapter = new DingTalkNotificationAdapter(() => cfg);
    const { impl, calls } = dingtalkFetchMock((url) => {
      if (url.includes("gettoken")) {
        return Response.json({ access_token: "corp-token", expires_in: 7200 });
      }
      if (url.includes("getbyunionid")) {
        return Response.json({ errcode: 60104, errmsg: "unionId 不存在" });
      }
      return Response.json({}, { status: 200 });
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const outcome = await adapter.sendText("staff-direct-1", "测试");
      expect(outcome.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const sendCall = calls.find((c) => c.url.includes("oToMessages"));
    expect((sendCall?.body as { userIds: string[] }).userIds).toEqual(["staff-direct-1"]);
  });

  it("投递失败错误收敛：保留 code/message，不回显响应原文（requestid 等）", async () => {
    resetDingTalkTokenCache();
    const cfg = { appKey: "ak", appSecret: "sk", robotCode: "rb" };
    const adapter = new DingTalkNotificationAdapter(() => cfg);
    const { impl } = dingtalkFetchMock((url) => {
      if (url.includes("gettoken")) {
        return Response.json({ access_token: "corp-token", expires_in: 7200 });
      }
      if (url.includes("getbyunionid")) {
        return Response.json({ errcode: 0, result: { userid: "staff-001" } });
      }
      return Response.json(
        {
          requestid: "01A0E7DE-C55E-7A42-99C6-B178C87D1132",
          code: "staffId.notExisted",
          message: "staff 不存在",
        },
        { status: 400 },
      );
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const outcome = await adapter.sendText("union-abc", "测试");
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("staffId.notExisted");
      expect(outcome.error).not.toContain("01A0E7DE");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
