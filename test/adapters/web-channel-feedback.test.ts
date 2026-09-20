import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";

/**
 * 反馈模块 API 契约（spec 2026-09-20-feedback-module-design）：
 * 覆盖 R1 越权必测项——详情/回复/附件 owner∥admin 判定 + 404 掩护、
 * 状态流转 admin 收口、附件上传-收编-回读全链路与穿越拒绝。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let feedbackStore: SqliteFeedbackStore;
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
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    feedbackStore,
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
