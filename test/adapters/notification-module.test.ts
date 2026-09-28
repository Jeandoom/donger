import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteLoopStore } from "../../src/adapters/sqlite-loop-store.js";
import { SqliteNotificationStore } from "../../src/adapters/sqlite-notification-store.js";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { LoopRunner } from "../../src/orchestrator/loop-runner.js";
import { NotificationService } from "../../src/orchestrator/notification-service.js";
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

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "notif-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  const notificationStore = new SqliteNotificationStore(db);
  notificationStore.migrate();
  notificationService = new NotificationService({ store: notificationStore });
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
      groups: Array<{ eventGroup: string; mandatory: boolean; inapp: boolean }>;
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
    expect(account?.inapp).toBe(true);

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
      groups: Array<{ eventGroup: string; inapp: boolean }>;
    };
    expect(after.groups.find((g) => g.eventGroup === "task")?.inapp).toBe(false);
  });

  it("反馈回复 → 提交者收站内信带 focus 深链；时间线/详情带姓名；公告群发可用", async () => {
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
    const timeline = (await (
      await get(port, `/api/feedback/${fb.id}/replies`, aliceToken)
    ).json()) as {
      replies: Array<{ authorName?: string }>;
    };
    expect(timeline.replies[0]?.authorName).toBe("rootadmin");
    const detail = (await (await get(port, `/api/feedback/${fb.id}`, adminToken)).json()) as {
      userName?: string;
    };
    expect(detail.userName).toBe("alice");

    // 公告群发：system.announcement 已登记（未登记时 fail-closed 抛错 500）
    const ann = await post(
      port,
      "/api/admin/notifications/announcement",
      { title: "维护通知", body: "今晚升级" },
      adminToken,
    );
    expect(ann.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const annList = (await (await get(port, "/api/notifications", aliceToken)).json()) as {
      items: Array<{ event: string }>;
    };
    expect(annList.items.some((n) => n.event === "system.announcement")).toBe(true);
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
  const runner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator: { handleMessage },
    workspaceRoot,
    channelId: "web",
    logger,
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
