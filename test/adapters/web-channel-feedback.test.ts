import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteAppStore } from "../../src/adapters/sqlite-app-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteMessageStore } from "../../src/adapters/sqlite-message-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * 反馈模块 API 契约（spec 2026-09-20-feedback-module-design）：
 * 覆盖 R1 越权必测项——详情/回复/附件 owner∥admin 判定 + 404 掩护、
 * 状态流转 admin 收口、附件上传-收编-回读全链路与穿越拒绝。
 * 另含反馈引用（# 触发器）解析与截图物化（spec 2026-09-22-feedback-as-reference-resource-design）。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let feedbackStore: SqliteFeedbackStore;
let messageStore: SqliteMessageStore;
let agentStore: SqliteAgentStore;
let convStore: SqliteConversationStore;
let appStore: SqliteAppStore;
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "feedback-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  agentStore = new SqliteAgentStore(db, createSecretCipher("pw"));
  agentStore.migrate();
  convStore = new SqliteConversationStore(db);
  convStore.migrate();
  appStore = new SqliteAppStore(db);
  appStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    feedbackStore,
    agentStore,
    conversationStore: convStore,
    messageStore,
    appStore,
    appsDir: tmpDir,
    appTokenSecret: "feedback-app-secret",
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function makeUser(name: string, role?: "admin"): Promise<{ id: string; token: string }> {
  const user = await userStore.getOrCreateByIdentity("test", name, name);
  if (role === "admin") await userStore.updateRole(user.id, "admin");
  const { token } = await sessionStore.create(user.id);
  return { id: user.id, token };
}

function req(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** PNG 头字节的假图片（服务端按扩展名+MIME 白名单，不验 magic） */
function imageForm(name = "截图.png"): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
    name,
  );
  return form;
}

beforeEach(() => {
  usersDir = mkdtempSync(join(tmpdir(), "fb-users-"));
  tmpDir = mkdtempSync(join(tmpdir(), "fb-ws-"));
});
afterEach(() => {
  void web?.stop();
  db?.close();
  rmSync(usersDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("反馈 API：创建与列表可见性", () => {
  it("member 创建归本人；member 列表仅本人；admin 全量且带 userName", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const admin = await makeUser("root", "admin");

    const created = await req(port, "POST", "/api/feedback", alice.token, {
      category: "ui",
      content: "按钮太小",
    });
    expect(created.status).toBe(201);
    const fb = (await created.json()) as { id: string; userId: string; status: string };
    expect(fb.userId).toBe(alice.id);
    expect(fb.status).toBe("open");

    await req(port, "POST", "/api/feedback", bob.token, { content: "bob 的反馈" });

    const aliceList = await req(port, "GET", "/api/feedback", alice.token);
    const aliceItems = ((await aliceList.json()) as { items: Array<{ id: string }> }).items;
    expect(aliceItems.map((i) => i.id)).toEqual([fb.id]);

    const adminList = await req(port, "GET", "/api/feedback", admin.token);
    const adminItems = (await adminList.json()) as {
      items: Array<{ id: string; userName: string }>;
    };
    expect(adminItems.items).toHaveLength(2);
    expect(adminItems.items.map((i) => i.userName)).toEqual(["bob", "alice"]);
  });

  it("category 缺省 other；content 空/超长 400；category 非法 400", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");

    const defaulted = await req(port, "POST", "/api/feedback", alice.token, { content: "x" });
    expect(((await defaulted.json()) as { category: string }).category).toBe("other");

    expect((await req(port, "POST", "/api/feedback", alice.token, { content: "  " })).status).toBe(
      400,
    );
    expect(
      (await req(port, "POST", "/api/feedback", alice.token, { content: "x".repeat(2001) })).status,
    ).toBe(400);
    expect(
      (await req(port, "POST", "/api/feedback", alice.token, { content: "x", category: "hack" }))
        .status,
    ).toBe(400);
  });
});

describe("反馈 API：R1 越权必测（详情/回复/附件）", () => {
  it("member 访问他人详情/回复 → 404 掩护；admin 直通", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const admin = await makeUser("root", "admin");
    const created = await req(port, "POST", "/api/feedback", alice.token, { content: "secret" });
    const { id } = (await created.json()) as { id: string };

    expect((await req(port, "GET", `/api/feedback/${id}`, bob.token)).status).toBe(404);
    expect((await req(port, "GET", `/api/feedback/${id}/replies`, bob.token)).status).toBe(404);
    expect((await req(port, "GET", `/api/feedback/${id}`, admin.token)).status).toBe(200);
    expect((await req(port, "GET", `/api/feedback/${id}`, alice.token)).status).toBe(200);
    expect((await req(port, "GET", "/api/feedback/ghost-id", admin.token)).status).toBe(404);
  });

  it("member 在他人反馈下回帖 → 404；本人回帖 authorRole=user、admin 回帖 authorRole=admin，时间线正序", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const admin = await makeUser("root", "admin");
    const { id } = (await (
      await req(port, "POST", "/api/feedback", alice.token, { content: "问题" })
    ).json()) as { id: string };

    expect(
      (await req(port, "POST", `/api/feedback/${id}/replies`, bob.token, { content: "插嘴" }))
        .status,
    ).toBe(404);

    const userReply = await req(port, "POST", `/api/feedback/${id}/replies`, alice.token, {
      content: "补充说明",
    });
    expect(userReply.status).toBe(201);
    expect(((await userReply.json()) as { authorRole: string }).authorRole).toBe("user");

    const adminReply = await req(port, "POST", `/api/feedback/${id}/replies`, admin.token, {
      content: "已收到，下版修复",
    });
    expect(((await adminReply.json()) as { authorRole: string }).authorRole).toBe("admin");

    const timeline = await req(port, "GET", `/api/feedback/${id}/replies`, alice.token);
    const { replies } = (await timeline.json()) as { replies: Array<{ content: string }> };
    expect(replies.map((r) => r.content)).toEqual(["补充说明", "已收到，下版修复"]);
  });
});

describe("反馈 API：状态流转 admin 收口", () => {
  it("member PATCH → 403（守卫 admin）；admin 合法流转 200；非法 status 400；不存在 404", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const admin = await makeUser("root", "admin");
    const { id } = (await (
      await req(port, "POST", "/api/feedback", alice.token, { content: "x" })
    ).json()) as { id: string };

    expect(
      (await req(port, "PATCH", `/api/feedback/${id}/status`, alice.token, { status: "resolved" }))
        .status,
    ).toBe(403);

    expect(
      (await req(port, "PATCH", `/api/feedback/${id}/status`, admin.token, { status: "accepted" }))
        .status,
    ).toBe(200);
    expect((await feedbackStore.get(id))?.status).toBe("accepted");

    expect(
      (await req(port, "PATCH", `/api/feedback/${id}/status`, admin.token, { status: "hacked" }))
        .status,
    ).toBe(400);
    expect(
      (await req(port, "PATCH", "/api/feedback/ghost/status", admin.token, { status: "open" }))
        .status,
    ).toBe(404);
  });
});

describe("反馈附件：上传-收编-回读全链路", () => {
  it("上传落草稿目录 → 创建反馈收编 → 属主/管理员可回读，他人 404，穿越名 404", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const admin = await makeUser("root", "admin");

    const upload = await realFetch(
      `http://127.0.0.1:${port}/api/feedback/attachments?key=draft-key-12345678`,
      { method: "POST", headers: { Authorization: `Bearer ${alice.token}` }, body: imageForm() },
    );
    expect(upload.status).toBe(200);
    const { name } = (await upload.json()) as { name: string };
    expect(name).toMatch(/^[\w.-]+\.png$/);

    const created = await req(port, "POST", "/api/feedback", alice.token, {
      content: "看截图",
      images: [name],
      key: "draft-key-12345678",
    });
    const { id } = (await created.json()) as { id: string };
    const detail = (await req(port, "GET", `/api/feedback/${id}`, alice.token).then((r) =>
      r.json(),
    )) as { images: string[] };
    expect(detail.images).toEqual([name]);

    const own = await realFetch(
      `http://127.0.0.1:${port}/api/feedback/${id}/attachments/${name}?token=${alice.token}`,
    );
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      true,
    );

    const adminRead = await realFetch(
      `http://127.0.0.1:${port}/api/feedback/${id}/attachments/${name}?token=${admin.token}`,
    );
    expect(adminRead.status).toBe(200);

    const other = await realFetch(
      `http://127.0.0.1:${port}/api/feedback/${id}/attachments/${name}?token=${bob.token}`,
    );
    expect(other.status).toBe(404);

    const traversal = await realFetch(
      `http://127.0.0.1:${port}/api/feedback/${id}/attachments/..?token=${alice.token}`,
    );
    expect(traversal.status).toBe(404);
  });

  it("非图片 400；超 2MB 400；key 非法 400", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");

    const badType = new FormData();
    badType.append("file", new Blob(["evil"], { type: "application/zip" }), "evil.zip");
    expect(
      (
        await realFetch(
          `http://127.0.0.1:${port}/api/feedback/attachments?key=draft-key-12345678`,
          { method: "POST", headers: { Authorization: `Bearer ${alice.token}` }, body: badType },
        )
      ).status,
    ).toBe(400);

    const tooBig = new FormData();
    tooBig.append(
      "file",
      new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/png" }),
      "big.png",
    );
    expect(
      (
        await realFetch(
          `http://127.0.0.1:${port}/api/feedback/attachments?key=draft-key-12345678`,
          { method: "POST", headers: { Authorization: `Bearer ${alice.token}` }, body: tooBig },
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await realFetch(`http://127.0.0.1:${port}/api/feedback/attachments?key=xx`, {
          method: "POST",
          headers: { Authorization: `Bearer ${alice.token}` },
          body: imageForm(),
        })
      ).status,
    ).toBe(400);
  });

  it("images 引用未上传文件名/路径形态 → 400", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    expect(
      (
        await req(port, "POST", "/api/feedback", alice.token, {
          content: "x",
          images: ["../evil.png"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await req(port, "POST", "/api/feedback", alice.token, { content: "x", images: [1] })).status,
    ).toBe(400);
  });
});

// ===== 反馈引用（# 触发器）解析与截图物化（spec 2026-09-22-feedback-as-reference-resource-design）=====

interface CapturedMentions {
  mentions?: Array<{
    kind: string;
    feedbackId?: string;
    content?: string;
    imagePaths?: string[];
    imagesOmitted?: number;
  }>;
}

function newFeedbackId(): string {
  return `fb-${Math.random().toString(36).slice(2, 10)}`;
}

/** 直入 store 建反馈（绕过 API 校验以便构造旧时间戳/多图等边界数据） */
async function seedFeedback(input: {
  id?: string;
  userId: string;
  content: string;
  images?: string[];
  conversationIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}): Promise<string> {
  const id = input.id ?? newFeedbackId();
  const now = new Date().toISOString();
  await feedbackStore.create({
    id,
    userId: input.userId,
    category: "ui",
    content: input.content,
    images: input.images ?? [],
    conversationIds: input.conversationIds ?? [],
    status: "open",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  });
  return id;
}

/** 在反馈附件目录落一张假图，返回文件名 */
function seedImage(feedbackId: string, name: string): string {
  const dir = join(tmpDir, "feedback", feedbackId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return name;
}

async function mkAgentWithScope(
  ownerId: string,
  scope: { enabled: boolean; days?: number; limit?: number },
): Promise<string> {
  const agent = await agentStore.create({
    ownerId,
    name: "FA",
    skills: [],
    tools: { mode: "all", whitelist: [] },
    mcpServers: [],
    gitRepositories: [],
    extensionDirectories: [],
    gitAllowShellGit: false,
    defaultPermissionMode: "ask_before_change",
    feedbackScope: scope,
  });
  return agent.id;
}

/** 模块级发送助手（带 mentions 的消息；反馈引用注入测试共用） */
async function send(port: number, token: string, convId: string, mentions: unknown) {
  return realFetch(`http://127.0.0.1:${port}/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text: "看反馈", mentions }),
  });
}

describe("反馈引用：发送解析（fail-closed + 可见性）", () => {
  async function send(port: number, token: string, convId: string, mentions: unknown) {
    return realFetch(`http://127.0.0.1:${port}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: "看反馈", mentions }),
    });
  }

  it("开关未开启：# 引用一律丢弃（不查库不注入）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: false });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const fbId = await seedFeedback({ userId: alice.id, content: "按钮太小" });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    expect(
      (await send(port, alice.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }])).status,
    ).toBe(202);
    expect(captured[0]?.mentions).toBeUndefined();
  });

  it("开启后引用本人反馈：注入 wrap 内容与截图物化（落会话私有附件目录）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const fbId = newFeedbackId();
    const img = seedImage(fbId, "1.png");
    await seedFeedback({ id: fbId, userId: alice.id, content: "手机上传无反应", images: [img] });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions).toHaveLength(1);
    const m = mentions[0]!;
    expect(m.kind).toBe("feedback");
    expect(m.feedbackId).toBe(fbId);
    expect(m.content).toContain("手机上传无反应");
    expect(m.content).toContain('source="feedback:');
    expect(m.content).toContain("待处理");
    // 截图物化：复制进会话附件目录，文件真实存在，命名带反馈 id 前缀
    expect(m.imagePaths).toHaveLength(1);
    const p = m.imagePaths?.[0] ?? "";
    expect(existsSync(p)).toBe(true);
    expect(p).toContain(`feedback-${fbId.slice(0, 8)}-1.png`);
    expect(m.imagesOmitted).toBe(0);
  });

  it("IDOR：member 引用他人反馈 → 静默丢弃", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(bob.id, "web", "t", agentId);
    const fbId = await seedFeedback({ userId: alice.id, content: "alice 的秘密反馈" });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, bob.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    expect(captured[0]?.mentions).toBeUndefined();
  });

  it("admin 引用他人反馈 → 注入（D2 拍板：admin 全量）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const admin = await makeUser("root", "admin");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(admin.id, "web", "t", agentId);
    const fbId = await seedFeedback({ userId: alice.id, content: "alice 的反馈" });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, admin.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.feedbackId).toBe(fbId);
  });

  it("单条显式引用也吃全套窗口过滤（days 滑出 → 丢弃）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true, days: 1 });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const fbId = await seedFeedback({
      userId: alice.id,
      content: "很久之前的反馈",
      createdAt: old,
      updatedAt: old,
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    expect(captured[0]?.mentions).toBeUndefined();
  });

  it("全部反馈哨兵展开（updatedAt 降序）；同消息重复引用同一反馈去重", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true, limit: 5 });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const old = await seedFeedback({
      userId: alice.id,
      content: "旧反馈",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const fresh = await seedFeedback({
      userId: alice.id,
      content: "新反馈",
      updatedAt: "2026-09-20T00:00:00.000Z",
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [
      { kind: "feedback", id: "__all__", label: "全部反馈" },
      { kind: "feedback", id: fresh, label: "重复" },
    ]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions.map((m) => m.feedbackId)).toEqual([fresh, old]);
  });
});

describe("反馈引用：截图物化降级与预算", () => {
  async function send(port: number, token: string, convId: string, mentions: unknown) {
    return realFetch(`http://127.0.0.1:${port}/api/conversations/${convId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: "看反馈", mentions }),
    });
  }

  it("截图文件缺失：不抛错、按张计入 imagesOmitted", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const fbId = newFeedbackId();
    seedImage(fbId, "1.png");
    await seedFeedback({
      id: fbId,
      userId: alice.id,
      content: "带丢失截图的反馈",
      images: ["1.png", "gone.png"],
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    const m = (captured[0]?.mentions ?? [])[0]!;
    expect(m.imagePaths).toHaveLength(1);
    expect(m.imagesOmitted).toBe(1);
  });

  it("截图预算 12 张跨反馈共享：超出部分不复制并计入 imagesOmitted", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    for (let i = 0; i < 3; i += 1) {
      const fbId = newFeedbackId();
      // 每条反馈 5 张（store 直入绕过 API 的 3 张上限，构造超预算场景）
      const names = ["1.png", "2.png", "3.png", "4.png", "5.png"].map((n) => seedImage(fbId, n));
      await seedFeedback({ id: fbId, userId: alice.id, content: `反馈 ${i}`, images: names });
    }

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [
      { kind: "feedback", id: "__all__", label: "全部反馈" },
    ]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions).toHaveLength(3);
    const totalInjected = mentions.reduce((n, m) => n + (m.imagePaths?.length ?? 0), 0);
    const totalOmitted = mentions.reduce((n, m) => n + (m.imagesOmitted ?? 0), 0);
    expect(totalInjected).toBe(12);
    expect(totalOmitted).toBe(3);
    for (const p of mentions.flatMap((m) => m.imagePaths ?? [])) {
      expect(existsSync(p)).toBe(true);
    }
  });
});

describe("反馈引用：候选下发（mention-candidates）", () => {
  const get = (port: number, token: string, agentId: string) =>
    realFetch(`http://127.0.0.1:${port}/api/agents/${agentId}/mention-candidates`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  it("开关未开启：feedbackRefEnabled=false 且候选恒空；开启后 member 仅本人、admin 全量", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const admin = await makeUser("root", "admin");
    const agentIdOff = await mkAgentWithScope(alice.id, { enabled: false });
    const off = (await (await get(port, alice.token, agentIdOff)).json()) as {
      feedbackRefEnabled: boolean;
      feedbacks: unknown[];
    };
    expect(off.feedbackRefEnabled).toBe(false);
    expect(off.feedbacks).toEqual([]);

    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    await seedFeedback({ userId: alice.id, content: "alice 的反馈内容" });
    await seedFeedback({ userId: bob.id, content: "bob 的反馈内容" });

    const mine = (await (await get(port, alice.token, agentId)).json()) as {
      feedbackRefEnabled: boolean;
      feedbacks: Array<{ label: string; preview: string }>;
    };
    expect(mine.feedbackRefEnabled).toBe(true);
    expect(mine.feedbacks).toHaveLength(1);
    expect(mine.feedbacks[0]?.label).toContain("alice的反馈内容");
    expect(mine.feedbacks[0]?.preview).toBe("alice 的反馈内容");

    const all = (await (await get(port, admin.token, agentId)).json()) as {
      feedbacks: Array<{ label: string }>;
    };
    expect(all.feedbacks).toHaveLength(2);
  });
});

describe("反馈关联对话记录：创建校验与候选分页", () => {
  it("附加本人会话 201 且 DTO 带 conversations；他人会话/不存在/多条/形态非法 → 400（IDOR）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const conv = await convStore.createWithAgent(alice.id, "web", "出错的会话", "");
    const bobConv = await convStore.createWithAgent(bob.id, "web", "bob 的会话", "");

    const ok = await req(port, "POST", "/api/feedback", alice.token, {
      content: "这个会话里助手答错了",
      conversationIds: [conv.id],
    });
    expect(ok.status).toBe(201);
    const fb = (await ok.json()) as {
      id: string;
      conversations: Array<{ id: string; title?: string }>;
    };
    expect(fb.conversations).toHaveLength(1);
    expect(fb.conversations[0]?.title).toBe("出错的会话");

    // 列表与详情 DTO 均带关联会话摘要
    const list = await req(port, "GET", "/api/feedback", alice.token);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      items: Array<{ id: string; conversations?: Array<{ title?: string }> }>;
    };
    expect(listBody.items[0]?.conversations).toHaveLength(1);
    const detail = await req(port, "GET", `/api/feedback/${fb.id}`, alice.token);
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { conversations?: Array<{ title?: string }> };
    expect(d.conversations?.[0]?.title).toBe("出错的会话");

    // IDOR：他人会话 → 400
    expect(
      (
        await req(port, "POST", "/api/feedback", alice.token, {
          content: "x",
          conversationIds: [bobConv.id],
        })
      ).status,
    ).toBe(400);
    // 不存在的会话 → 400
    expect(
      (
        await req(port, "POST", "/api/feedback", alice.token, {
          content: "x",
          conversationIds: ["does-not-exist-0001"],
        })
      ).status,
    ).toBe(400);
    // 多条 → 400（D1 拍板：M1 单条）
    expect(
      (
        await req(port, "POST", "/api/feedback", alice.token, {
          content: "x",
          conversationIds: [conv.id, bobConv.id],
        })
      ).status,
    ).toBe(400);
    // 形态非法 → 400
    expect(
      (
        await req(port, "POST", "/api/feedback", alice.token, {
          content: "x",
          conversationIds: ["short"],
        })
      ).status,
    ).toBe(400);
  });

  it("candidates：仅本人会话、updatedAt 降序、分页与关键词过滤；未登录 401", async () => {
    const port = await startChannel();
    const anon = await req(port, "GET", "/api/feedback/conversation-candidates");
    expect(anon.status).toBe(401);

    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    for (let i = 0; i < 12; i++) {
      await convStore.createWithAgent(alice.id, "web", `会话-${String(i).padStart(2, "0")}`, "");
      // 错开 updatedAt 保证降序断言稳定（同毫秒创建会打乱排序）
      await new Promise((r) => setTimeout(r, 3));
    }
    await convStore.createWithAgent(bob.id, "web", "bob 专属", "");

    const p1 = (await (
      await req(port, "GET", "/api/feedback/conversation-candidates", alice.token)
    ).json()) as { items: Array<{ title: string }>; total: number };
    expect(p1.total).toBe(12);
    expect(p1.items).toHaveLength(10);
    expect(p1.items[0]?.title).toBe("会话-11");

    const p2 = (await (
      await req(port, "GET", "/api/feedback/conversation-candidates?offset=10", alice.token)
    ).json()) as { items: Array<{ title: string }>; total: number };
    expect(p2.items).toHaveLength(2);
    expect(p2.items[0]?.title).toBe("会话-01");

    const q = (await (
      await req(
        port,
        "GET",
        `/api/feedback/conversation-candidates?q=${encodeURIComponent("会话-0")}`,
        alice.token,
      )
    ).json()) as { total: number };
    expect(q.total).toBe(10);

    // member 只看本人会话
    const b = (await (
      await req(port, "GET", "/api/feedback/conversation-candidates", bob.token)
    ).json()) as { total: number };
    expect(b.total).toBe(1);
  });
});

describe("反馈关联对话记录：# 引用按需注入转录（D2 指针/D3 反馈开关总闸）", () => {
  it("引用带关联会话的反馈 → 同一 wrap 块内含转录（用户/助手行）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);
    const target = await convStore.createWithAgent(alice.id, "web", "出问题的会话", agentId);
    await messageStore.add(target.id, "user", "你好，帮我算下 1+1");
    await messageStore.add(target.id, "bot", "1+1 等于 3");
    const fbId = await seedFeedback({
      userId: alice.id,
      content: "助手算错了",
      conversationIds: [target.id],
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions).toHaveLength(1);
    const m = mentions[0]!;
    expect(m.kind).toBe("feedback");
    // 转录与反馈正文同处一个 wrapUntrusted 块
    expect(m.content).toContain("【反馈】");
    expect(m.content).toContain("助手算错了");
    expect(m.content).toContain("【关联对话记录】出问题的会话：");
    expect(m.content).toContain("【用户】你好，帮我算下 1+1");
    expect(m.content).toContain("【助手】1+1 等于 3");
    expect(m.content).toContain('source="feedback:');
    expect(m.imagesOmitted).toBe(0);
  });

  it("关联会话已删除 → 注入块声明缺失不抛错；超长转录保尾部并声明截断", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const agentId = await mkAgentWithScope(alice.id, { enabled: true });
    const conv = await convStore.createWithAgent(alice.id, "web", "t", agentId);

    // 缺失会话：指针指向已不存在的 id
    const fbMissing = await seedFeedback({
      userId: alice.id,
      content: "缺失场景",
      conversationIds: ["ghost-conversation-0001"],
    });

    // 超长转录：两条 25k 消息（合计 >20k），保尾 20k 为纯 B 段且头行声明
    const target = await convStore.createWithAgent(alice.id, "web", "超长会话", agentId);
    await messageStore.add(target.id, "user", "A".repeat(25_000));
    await messageStore.add(target.id, "bot", "B".repeat(25_000));
    const fbLong = await seedFeedback({
      userId: alice.id,
      content: "超长场景",
      conversationIds: [target.id],
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, alice.token, conv.id, [
      { kind: "feedback", id: fbMissing, label: "m" },
      { kind: "feedback", id: fbLong, label: "l" },
    ]);
    const mentions = captured[0]?.mentions ?? [];
    expect(mentions).toHaveLength(2);
    const missing = mentions.find((x) => x.feedbackId === fbMissing);
    expect(missing?.content).toContain("【关联对话记录】（会话已删除或不可见）");

    const long = mentions.find((x) => x.feedbackId === fbLong)!;
    expect(long.content).toContain("【关联对话记录】超长会话（超长已截断）：");
    expect(long.content).toContain("（前文已截断）");
    // 保尾部：末尾的 B 串在、开头的 A 串不在
    expect(long.content).toContain("BBBB");
    expect(long.content).not.toContain("AAAA");
    expect(long.content.length).toBeLessThan(25_000);
  });

  it("admin 引用 member 反馈（带关联会话）→ 转录注入（可见性同反馈口径）", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const admin = await makeUser("root2", "admin");
    const agentId = await mkAgentWithScope(admin.id, { enabled: true });
    const conv = await convStore.createWithAgent(admin.id, "web", "t", agentId);
    const target = await convStore.createWithAgent(alice.id, "web", "alice 的会话", "");
    await messageStore.add(target.id, "user", "alice 的原始问题");
    const fbId = await seedFeedback({
      userId: alice.id,
      content: "alice 的反馈",
      conversationIds: [target.id],
    });

    const captured: CapturedMentions[] = [];
    web.onMessage((m) => captured.push(m as CapturedMentions));
    await send(port, admin.token, conv.id, [{ kind: "feedback", id: fbId, label: "x" }]);
    const m = (captured[0]?.mentions ?? [])[0]!;
    expect(m.content).toContain("【关联对话记录】alice 的会话：");
    expect(m.content).toContain("【用户】alice 的原始问题");
  });
});

describe("反馈关联应用（应用管家制 spec §7）", () => {
  it("本人应用可关联并回传 appId；他人应用/幽灵应用 400；缺省不落", async () => {
    const port = await startChannel();
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const appId = "app_test1";
    await appStore.create({
      id: appId,
      userId: alice.id,
      name: "测试应用",
      description: "",
      manifest: {
        manifestVersion: 1,
        runtime: "static",
        ui: { spa: true },
        access: "private",
      },
    });
    const ok = await req(port, "POST", "/api/feedback", alice.token, {
      content: "应用反馈",
      appId,
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { appId?: string }).appId).toBe(appId);

    expect(
      (await req(port, "POST", "/api/feedback", bob.token, { content: "x", appId })).status,
    ).toBe(400);
    expect(
      (await req(port, "POST", "/api/feedback", alice.token, { content: "x", appId: "app_ghost" }))
        .status,
    ).toBe(400);
    expect(
      (await req(port, "POST", "/api/feedback", alice.token, { content: "x", appId: 42 })).status,
    ).toBe(400);

    const plain = await req(port, "POST", "/api/feedback", alice.token, { content: "平台反馈" });
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as { appId?: string }).appId).toBeUndefined();
  });
});
