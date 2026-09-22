import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "../../src/adapters/sqlite-kb-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { kbRootDir } from "../../src/util/kb-files.js";

/**
 * 知识库 API 契约（spec §7）：创建/查看/PATCH/删除（账本保留）/目录树/entry 读取/
 * 分享全链路（token→accept→被分享者只读）/duplicate，及 IDOR 必测项
 * （跨用户访问 403/404 掩护、personal 禁分享禁删除、builtin 不可删）。
 */

let web: WebChannel;
let db: Database.Database;
let usersDir: string;
let tmpDir: string;
let userStore: SqliteUserStore;
let sessionStore: JwtSessionStore;
let libraries: SqliteKbLibraryStore;
let shares: SqliteKbShareStore;
let revisions: SqliteKbRevisionStore;
const realFetch = globalThis.fetch;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "kb-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir });
  userStore.migrate();
  userStore.migrateCredentials();
  libraries = new SqliteKbLibraryStore(db);
  libraries.migrate();
  shares = new SqliteKbShareStore(db);
  shares.migrate();
  revisions = new SqliteKbRevisionStore(db);
  revisions.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    kbLibraryStore: libraries,
    kbShareStore: shares,
    kbRevisionStore: revisions,
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

let port: number;
const alice = { token: "", id: "" };
const bob = { token: "", id: "" };
const admin = { token: "", id: "" };

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kb-api-"));
  usersDir = join(tmpDir, "users");
  port = await startChannel();
  const a = await makeUser("alice");
  alice.token = a.token;
  alice.id = a.id;
  const b = await makeUser("bob");
  bob.token = b.token;
  bob.id = b.id;
  const ad = await makeUser("root", "admin");
  admin.token = ad.token;
  admin.id = ad.id;
});

afterEach(() => {
  web.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createKb(
  token: string,
  name: string,
  extra?: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const r = await req(port, "POST", "/api/kb", token, { name, ...extra });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; name: string };
}

describe("GET/POST /api/kb", () => {
  it("首次列表懒 ensure 个人库（置顶、personal 标记）", async () => {
    const r = await req(port, "GET", "/api/kb", alice.token);
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{ name: string; personal: boolean; _role: string }>;
    expect(list[0]?.name).toBe("个人知识库");
    expect(list[0]?.personal).toBe(true);
    expect(list[0]?._role).toBe("manage");
    // 二次调用不重复
    const r2 = await req(port, "GET", "/api/kb", alice.token);
    expect(((await r2.json()) as unknown[]).length).toBe(1);
  });

  it("建库生成骨架 index.md 与 create 修订；同名 409", async () => {
    const kb = await createKb(alice.token, "产品手册", { description: "产品相关" });
    const tree = (await (await req(port, "GET", `/api/kb/${kb.id}/tree`, alice.token)).json()) as {
      entries: Array<{ path: string }>;
    };
    expect(tree.entries.some((e) => e.path === "index.md")).toBe(true);
    const revs = (await (await req(port, "GET", `/api/kb/${kb.id}/revisions`, alice.token)).json()) as {
      revisions: Array<{ action: string; path: string }>;
    };
    expect(revs.revisions[0]?.action).toBe("create");
    expect(revs.revisions[0]?.path).toBe("index.md");
    const dup = await req(port, "POST", "/api/kb", alice.token, { name: "产品手册" });
    expect(dup.status).toBe(409);
  });

  it("未登录 401（守卫 fail-closed）", async () => {
    expect((await req(port, "GET", "/api/kb")).status).toBe(401);
  });
});

describe("GET/PATCH/DELETE /api/kb/:id", () => {
  it("详情带 systemPrompt；PATCH 记 config 修订", async () => {
    const kb = await createKb(alice.token, "配置库");
    const detail = (await (await req(port, "GET", `/api/kb/${kb.id}`, alice.token)).json()) as {
      systemPrompt?: string;
      _role: string;
    };
    expect(detail._role).toBe("manage");
    const pr = await req(port, "PATCH", `/api/kb/${kb.id}`, alice.token, {
      systemPrompt: "按主题分目录组织",
    });
    expect(pr.status).toBe(200);
    const revs = (await (await req(port, "GET", `/api/kb/${kb.id}/revisions`, alice.token)).json()) as {
      revisions: Array<{ action: string; diffText?: string }>;
    };
    expect(revs.revisions[0]?.action).toBe("config");
    expect(revs.revisions[0]?.diffText ?? "").toMatch(/\+.*按主题分目录组织/);
  });

  it("IDOR：非属主/非授予者 PATCH 403、DELETE 403；被授予者可读不可管理", async () => {
    const kb = await createKb(alice.token, "保密库");
    expect((await req(port, "PATCH", `/api/kb/${kb.id}`, bob.token, { name: "抢" })).status).toBe(403);
    expect((await req(port, "DELETE", `/api/kb/${kb.id}`, bob.token)).status).toBe(403);
    expect((await req(port, "GET", `/api/kb/${kb.id}`, bob.token)).status).toBe(403);
    // admin 直通（canManageKb）
    const adminPatch = await req(port, "PATCH", `/api/kb/${kb.id}`, admin.token, {
      description: "admin 代管",
    });
    expect(adminPatch.status).toBe(200);
  });

  it("删除：个人库/内置库 403；普通库删除后账本保留+library-deleted 尾条", async () => {
    const list = (await (await req(port, "GET", "/api/kb", alice.token)).json()) as Array<{
      id: string;
      personal: boolean;
    }>;
    const personal = list.find((l) => l.personal);
    expect((await req(port, "DELETE", `/api/kb/${personal?.id}`, alice.token)).status).toBe(403);

    const kb = await createKb(alice.token, "待删除");
    const dr = await req(port, "DELETE", `/api/kb/${kb.id}`, alice.token);
    expect(dr.status).toBe(200);
    expect(((await dr.json()) as { revisionsKept: number }).revisionsKept).toBeGreaterThanOrEqual(2);
    expect((await req(port, "GET", `/api/kb/${kb.id}`, alice.token)).status).toBe(404);
    // 账本独立可查（审计：删库不断链）
    expect(revisions.listByKb(kb.id)).resolves.toHaveLength(2);
  });
});

describe("entry 与越界", () => {
  it("entry 读 .md；非 .md 拒绝；path 越界 404 掩护", async () => {
    const kb = await createKb(alice.token, "entry 库");
    // 骨架可读
    const r = await req(port, "GET", `/api/kb/${kb.id}/entry?path=index.md`, alice.token);
    const body = (await r.json()) as { content: string };
    expect(body.content).toContain("entry 库");
    // 非 .md
    expect(
      (await req(port, "GET", `/api/kb/${kb.id}/entry?path=secret.json`, alice.token)).status,
    ).toBe(404);
    // 越界（.. 穿越被 containment 挡）
    const esc = await req(
      port,
      "GET",
      `/api/kb/${kb.id}/entry?path=${encodeURIComponent("../../alice-secret.md")}`,
      alice.token,
    );
    expect(esc.status).toBe(404);
  });
});

describe("分享链路", () => {
  it("token→探查→accept→被分享者可读、PATCH 403、无写入口", async () => {
    const kb = await createKb(alice.token, "共享库");
    // personal 库禁分享
    const list = (await (await req(port, "GET", "/api/kb", alice.token)).json()) as Array<{
      id: string;
      personal: boolean;
    }>;
    const personalId = list.find((l) => l.personal)?.id ?? "";
    const pShare = await req(port, "POST", `/api/kb/${personalId}/share`, alice.token, {
      enabled: true,
    });
    expect(pShare.status).toBe(403);

    const er = await req(port, "POST", `/api/kb/${kb.id}/share`, alice.token, { enabled: true });
    expect(er.status).toBe(200);
    const { token } = (await er.json()) as { token: string };

    const probe = await req(port, "GET", `/api/kb/by-share/${token}`);
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { name: string }).name).toBe("共享库");

    const acc = await req(port, "POST", `/api/kb/${kb.id}/accept-share`, bob.token, { token });
    expect(acc.status).toBe(200);
    // 被分享者：读 OK
    const read = await req(port, "GET", `/api/kb/${kb.id}`, bob.token);
    expect(((await read.json()) as { _role: string })._role).toBe("use");
    // 写 403（D1）
    expect((await req(port, "PATCH", `/api/kb/${kb.id}`, bob.token, { name: "改" })).status).toBe(403);
    // 关闭分享后授权失效
    await req(port, "POST", `/api/kb/${kb.id}/share`, alice.token, { enabled: false });
    expect((await req(port, "GET", `/api/kb/${kb.id}`, bob.token)).status).toBe(403);
  });
});

describe("duplicate", () => {
  it("复制目录与配置，不带修订历史；personal 仅本人可复制", async () => {
    const kb = await createKb(alice.token, "原库");
    const dup = await req(port, "POST", `/api/kb/${kb.id}/duplicate`, alice.token);
    expect(dup.status).toBe(201);
    const copy = (await dup.json()) as { id: string; name: string };
    expect(copy.name).toBe("原库-副本");
    const content = (
      await (await req(port, "GET", `/api/kb/${copy.id}/entry?path=index.md`, alice.token)).json()
    ) as { content: string };
    expect(content.content).toContain("原库");
    // 副本账本只有一条 create（不含原库修订）
    const revs = (
      await (await req(port, "GET", `/api/kb/${copy.id}/revisions`, alice.token)).json()
    ) as { revisions: unknown[] };
    expect(revs.revisions).toHaveLength(1);
    // bob 未授权不能复制
    expect((await req(port, "POST", `/api/kb/${kb.id}/duplicate`, bob.token)).status).toBe(403);
  });
});

describe("builtin 库权限", () => {
  it("系统默认库：普通用户可读、不可改不可删；admin 可改（D3）", async () => {
    const builtin = await libraries.create({
      ownerId: "__builtin__",
      name: "平台使用手册",
      description: "",
      systemPrompt: "",
      builtin: true,
      personal: false,
    });
    const read = await req(port, "GET", `/api/kb/${builtin.id}`, bob.token);
    expect(read.status).toBe(200);
    expect((await req(port, "PATCH", `/api/kb/${builtin.id}`, bob.token, { name: "x" })).status).toBe(403);
    expect((await req(port, "DELETE", `/api/kb/${builtin.id}`, admin.token)).status).toBe(403);
    expect((await req(port, "POST", `/api/kb/${builtin.id}/share`, admin.token, { enabled: true })).status).toBe(403);
    // admin 可维护
    expect((await req(port, "PATCH", `/api/kb/${builtin.id}`, admin.token, { description: "admin 维护" })).status).toBe(200);
  });
});

describe("文件真源一致性", () => {
  it("库目录落 <workspaceDir>/kb/<kbId>/，删除后目录清空", async () => {
    const kb = await createKb(alice.token, "真源库");
    const root = kbRootDir(tmpDir, kb.id);
    expect(readFileSync(join(root, "index.md"), "utf8")).toContain("真源库");
    await req(port, "DELETE", `/api/kb/${kb.id}`, alice.token);
    expect(existsSync(root)).toBe(false);
  });
});
