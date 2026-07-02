import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { resolveStaticFile, WebChannel } from "../../src/adapters/web-channel";

function makeWebRoot(): string {
  return mkdtempSync(join(tmpdir(), "webroot-"));
}

/** 写文件并自动创建父目录（writeFileSync 不会自动建目录） */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("resolveStaticFile", () => {
  let root: string;
  beforeEach(() => {
    root = makeWebRoot();
  });

  it("有 dist 时，/ 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/");
    expect(r?.kind).toBe("file");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
    expect(existsSync(r?.absPath ?? "")).toBe(true);
  });

  it("有 dist 时，/index.html 返回 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/index.html");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，未知路径走 SPA fallback 到 dist/index.html", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/agents");
    expect(r?.absPath).toBe(join(root, "dist", "index.html"));
  });

  it("有 dist 时，/assets 下真实文件直返", () => {
    write(root, "dist/index.html", "built");
    write(root, "dist/assets/app.js", "// js");
    const r = resolveStaticFile(root, "/assets/app.js");
    expect(r?.absPath).toBe(join(root, "dist", "assets", "app.js"));
  });

  it("有 dist 时，/assets 缺失文件返回 null（404）", () => {
    write(root, "dist/index.html", "built");
    const r = resolveStaticFile(root, "/assets/missing.js");
    expect(r).toBeNull();
  });

  it("无 dist 时，/ 返回 null（未构建）", () => {
    const r = resolveStaticFile(root, "/");
    expect(r).toBeNull();
  });

  it("无 dist 时，未知路径返回 null", () => {
    const r = resolveStaticFile(root, "/agents");
    expect(r).toBeNull();
  });
});

let web: WebChannel;
afterEach(() => web?.stop());

async function startWith(usageStore: InMemoryUsageStore): Promise<number> {
  web = new WebChannel({ port: 0, usageStore });
  web.onMessage(() => {});
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return port;
}

function rec(userId: string, taskId: string) {
  return {
    taskId,
    userId,
    channelId: "web",
    model: "glm-4.6",
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

describe("WebChannel GET /api/usage", () => {
  it("返回 records 列表", async () => {
    const store = new InMemoryUsageStore();
    await store.record(rec("u1", "t1"));
    const port = await startWith(store);
    const res = await fetch(`http://localhost:${port}/api/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { userId: string }[] };
    expect(body.records.length).toBe(1);
    expect(body.records[0]?.userId).toBe("u1");
  });

  it("按 userId 过滤", async () => {
    const store = new InMemoryUsageStore();
    await store.record(rec("u1", "t1"));
    await store.record(rec("u2", "t2"));
    const port = await startWith(store);
    const res = await fetch(`http://localhost:${port}/api/usage?userId=u1`);
    const body = (await res.json()) as { records: { userId: string }[] };
    expect(body.records.length).toBe(1);
    expect(body.records[0]?.userId).toBe("u1");
  });

  it("limit 非法 → 400", async () => {
    const port = await startWith(new InMemoryUsageStore());
    const res = await fetch(`http://localhost:${port}/api/usage?limit=abc`);
    expect(res.status).toBe(400);
  });
});

function auditEvent(over: Record<string, unknown>) {
  return { userId: "u1", recordedAt: "2026-07-01T00:00:00.000Z", ...over };
}

describe("WebChannel GET /api/audit/conversations", () => {
  it("返回会话列表（补 title，按 lastAt 倒序）", async () => {
    const db = new Database(":memory:");
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const created = await conversationStore.create("u1", "web", "修登录bug");
    const auditStore = new InMemoryAuditStore();
    await auditStore.record(
      auditEvent({
        conversationId: created.id,
        taskId: "t1",
        seq: 0,
        type: "user_message",
        text: "hi",
      }) as never,
    );
    web = new WebChannel({ port: 0, conversationStore, auditStore });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://localhost:${port}/api/audit/conversations`);
    const body = (await res.json()) as Array<{
      conversationId: string;
      title: string;
      turnCount: number;
    }>;
    expect(res.status).toBe(200);
    expect(body[0]?.conversationId).toBe(created.id);
    expect(body[0]?.title).toBe("修登录bug");
    expect(body[0]?.turnCount).toBe(1);
    db.close();
  });
});

describe("WebChannel GET /api/audit/conversations/:id", () => {
  it("返回按轮分组的详情", async () => {
    const db = new Database(":memory:");
    const conversationStore = new SqliteConversationStore(db);
    conversationStore.migrate();
    const created = await conversationStore.create("u1", "web", "t");
    const taskStore = new InMemoryTaskStore();
    const auditStore = new InMemoryAuditStore();
    await auditStore.record(
      auditEvent({
        conversationId: created.id,
        taskId: "t1",
        seq: 0,
        type: "user_message",
        text: "hi",
      }) as never,
    );
    web = new WebChannel({ port: 0, conversationStore, taskStore, auditStore });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://localhost:${port}/api/audit/conversations/${created.id}`);
    const body = (await res.json()) as {
      turns: Array<{ taskId: string; events: Array<{ type: string }> }>;
    };
    expect(res.status).toBe(200);
    expect(body.turns[0]?.taskId).toBe("t1");
    expect(body.turns[0]?.events[0]?.type).toBe("user_message");
    db.close();
  });

  it("无数据 → 404", async () => {
    web = new WebChannel({ port: 0, auditStore: new InMemoryAuditStore() });
    web.onMessage(() => {});
    await web.ready();
    const port = web.boundPort;
    if (!port) throw new Error("no port");
    const res = await fetch(`http://localhost:${port}/api/audit/conversations/nope`);
    expect(res.status).toBe(404);
  });
});
