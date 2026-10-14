import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { SqliteModuleConfigStore } from "../../src/adapters/sqlite-module-config-store.js";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "../../src/adapters/sqlite-kb-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { kbRootDir } from "../../src/util/kb-files.js";

/**
 * 个人库记忆分区 API 契约（知识体系轮 P2）：
 * GET /api/kb/:id/memory（可管理者）、POST /api/kb/:id/memory/migrate-legacy（迁移+修订留痕）、
 * GET/PUT /api/admin/memory-channel（admin 全局档位，member 403）。
 */

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let userStore: SqliteUserStore;
let moduleConfigStore: SqliteModuleConfigStore;
let sessionStore: JwtSessionStore;

async function startChannel(): Promise<number> {
  db = new Database(":memory:");
  sessionStore = new JwtSessionStore(db, "kb-mem-secret");
  sessionStore.migrate();
  userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: join(tmpDir, "users") });
  userStore.migrate();
  userStore.migrateCredentials();
  const libraries = new SqliteKbLibraryStore(db);
  libraries.migrate();
  const shares = new SqliteKbShareStore(db);
  shares.migrate();
  const revisions = new SqliteKbRevisionStore(db);
  revisions.migrate();
  moduleConfigStore = new SqliteModuleConfigStore(db, "kb-mem-seed");
  moduleConfigStore.migrate();
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    kbLibraryStore: libraries,
    kbShareStore: shares,
    kbRevisionStore: revisions,
    moduleConfigStore,
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

async function createKb(port: number, token: string, name: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/api/kb`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: "" }),
  });
  expect([200, 201]).toContain(r.status);
  const body = (await r.json()) as { id: string; kb?: { id: string } };
  return body.id ?? body.kb?.id ?? "";
}

let port: number;
const owner = { token: "", id: "" };
const other = { token: "", id: "" };
let kbId = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "kb-mem-"));
  port = await startChannel();
  const a = await makeUser("owner");
  owner.id = a.id;
  owner.token = a.token;
  const b = await makeUser("other");
  other.id = b.id;
  other.token = b.token;
  kbId = await createKb(port, owner.token, "mem-lib");
});

afterEach(() => {
  web.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET/POST /api/kb/:id/memory*", () => {
  it("非可管理者 403", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/kb/${kbId}/memory`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(r.status).toBe(403);
  });

  it("读记忆面板：mode/curated/indexLines/legacyCount；迁移移动顶层并留修订", async () => {
    const root = kbRootDir(tmpDir, kbId);
    const memDir = join(root, "memory");
    mkdirSync(join(memDir, "curated"), { recursive: true });
    writeFileSync(join(memDir, "curated", "INDEX.md"), "- [条目A](curated/a.md) — 钩子\n", "utf8");
    writeFileSync(join(memDir, "curated", "a.md"), "# 条目A\n\n详情", "utf8");
    writeFileSync(join(memDir, "legacy.md"), "# 旧顶层\n\n内容", "utf8");

    const read = await fetch(`http://127.0.0.1:${port}/api/kb/${kbId}/memory`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      mode: string;
      curated: Array<{ filename: string }>;
      indexLines: number;
      legacyCount: number;
    };
    expect(body.mode).toBe("curated");
    expect(body.curated.map((c) => c.filename)).toEqual(["curated/a.md"]);
    expect(body.indexLines).toBe(1);
    expect(body.legacyCount).toBe(1);

    const mig = await fetch(`http://127.0.0.1:${port}/api/kb/${kbId}/memory/migrate-legacy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(mig.status).toBe(200);
    expect(((await mig.json()) as { moved: number }).moved).toBe(1);

    const after = (await (
      await fetch(`http://127.0.0.1:${port}/api/kb/${kbId}/memory`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
    ).json()) as { legacyCount: number };
    expect(after.legacyCount).toBe(0);

    // 修订留痕（actorKind=memory-consolidation）
    const revs = await fetch(`http://127.0.0.1:${port}/api/kb/${kbId}/revisions`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const revBody = (await revs.json()) as {
      items?: Array<{ actorKind?: string }> | Array<Array<{ actorKind?: string }>>;
    };
    const flat = Array.isArray(revBody.items)
      ? revBody.items.flat()
      : (Object.values(revBody).flat() as Array<{ actorKind?: string }>);
    expect(JSON.stringify(flat)).toContain("memory-consolidation");
  });

  it("GET/PUT /api/admin/memory-channel：member 403，admin 设置生效", async () => {
    const get = (token: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/admin/memory-channel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await get(other.token)).status).toBe(403);
    const put = await fetch(`http://127.0.0.1:${port}/api/admin/memory-channel`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${other.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "legacy" }),
    });
    expect(put.status).toBe(403);

    const adminUser = await makeUser("boss", "admin");
    const putAdmin = await fetch(`http://127.0.0.1:${port}/api/admin/memory-channel`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminUser.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "legacy" }),
    });
    expect(putAdmin.status).toBe(200);
    const body = (await (await get(adminUser.token)).json()) as { mode: string };
    expect(body.mode).toBe("legacy");
    expect(moduleConfigStore.getFlag("memory.channel")).toBe("legacy");
  });
});
