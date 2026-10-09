import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import type { EventInput } from "../../src/domain/event.js";

const scheduleInput = (over: Partial<EventInput> = {}): EventInput => ({
  name: "E",
  type: "schedule",
  schedule: {
    cron: "* * * * *",
    mode: "conditional",
    source: { type: "file", path: "/x" },
    matcher: { kind: "always" },
  },
  ...over,
});

describe("SqliteEventStore", () => {
  let db: Database.Database;
  let es: SqliteEventStore;
  let ws: SqliteWorkflowStore;

  beforeEach(() => {
    db = new Database(":memory:");
    es = new SqliteEventStore(db);
    es.migrate();
    ws = new SqliteWorkflowStore(db);
    ws.migrate();
  });

  it("create + get roundtrip（无条件定时无 source/matcher）", async () => {
    const e = await es.create({
      ownerId: "u1",
      name: "早报",
      type: "schedule",
      schedule: { cron: "0 9 * * *", mode: "unconditional" },
    });
    expect(e.id).toBeTruthy();
    const loaded = await es.get(e.id);
    expect(loaded?.name).toBe("早报");
    expect(loaded?.schedule?.mode).toBe("unconditional");
  });

  it("call 事件 findByCallPath + update 不换 path", async () => {
    const e = await es.create({
      ownerId: "u1",
      name: "回调",
      type: "call",
      call: {
        path: "/hooks/abcdef01",
        methods: ["GET", "POST"],
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    expect((await es.findByCallPath("/hooks/abcdef01"))?.id).toBe(e.id);
    expect(await es.findByCallPath("/hooks/missing")).toBeUndefined();

    const next = await es.update(e.id, {
      name: "回调2",
      type: "call",
      call: {
        path: "/hooks/hacked",
        methods: ["GET", "POST"],
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    expect(next.call?.path).toBe("/hooks/abcdef01");
  });

  it("listByOwner/listAll/系统事件过滤", async () => {
    await es.create({ ownerId: "u1", ...scheduleInput({ name: "A" }) });
    await es.create({ ownerId: "u2", ...scheduleInput({ name: "B" }) });
    await es.create({
      ownerId: "u1",
      name: "反馈",
      type: "system",
      system: { name: "feedback.created", matcher: { kind: "always" } },
    });
    expect((await es.listByOwner("u1")).length).toBe(2);
    expect((await es.listAll()).filter((e) => e.type === "system").length).toBe(1);
  });

  it("updateRuntimeState 回写 lastFiredAt", async () => {
    const e = await es.create({ ownerId: "u1", ...scheduleInput() });
    await es.updateRuntimeState(e.id, { lastFiredAt: "2026-10-09T00:00:00Z" });
    expect((await es.get(e.id))?.lastFiredAt).toBe("2026-10-09T00:00:00Z");
  });

  it("delete 移除行", async () => {
    const e = await es.create({ ownerId: "u1", ...scheduleInput() });
    await es.delete(e.id);
    expect(await es.get(e.id)).toBeUndefined();
  });

  it("update 修改 name 与 matcher", async () => {
    const e = await es.create({ ownerId: "u1", ...scheduleInput() });
    const next = await es.update(e.id, {
      name: "E2",
      type: "schedule",
      schedule: {
        cron: "0 * * * *",
        mode: "conditional",
        source: { type: "file", path: "/x" },
        matcher: { kind: "bodyContains", keyword: "err" },
      },
    });
    expect(next.name).toBe("E2");
    expect(next.schedule?.matcher.kind).toBe("bodyContains");
    expect((await es.get(e.id))?.schedule?.matcher.kind).toBe("bodyContains");
  });

  it("存量 triggers 表一次性映射：scheduler→schedule/hook→call(重新随机)/event→system/git→删除", async () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE triggers (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL, config TEXT NOT NULL, lastState TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )
    `);
    const ins = legacy.prepare(
      "INSERT INTO triggers (id, ownerId, name, type, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
    );
    ins.run(
      "t1",
      "u1",
      "旧定时",
      "scheduler",
      JSON.stringify({
        scheduler: {
          cron: "0 9 * * *",
          source: { type: "http", url: "https://x" },
          matcher: { kind: "always" },
        },
      }),
      "now",
      "now",
    );
    ins.run(
      "t2",
      "u1",
      "旧回调",
      "hook",
      JSON.stringify({
        hook: {
          path: "/hooks/oldpath",
          responseStatus: 200,
          responseBody: "ok",
          matcher: { kind: "always" },
        },
      }),
      "now",
      "now",
    );
    ins.run(
      "t3",
      "u1",
      "旧事件",
      "event",
      JSON.stringify({
        event: { name: "feedback.created", matcher: { kind: "always" } },
      }),
      "now",
      "now",
    );
    ins.run(
      "t4",
      "u1",
      "旧git",
      "git",
      JSON.stringify({
        git: { provider: "gitee", repoUrl: "https://gitee.com/o/r.git", branch: "master" },
      }),
      "now",
      "now",
    );

    const store = new SqliteEventStore(legacy);
    store.migrate();

    expect(await store.get("t1")).not.toBeUndefined();
    const t1 = await store.get("t1");
    expect(t1?.type).toBe("schedule");
    expect(t1?.schedule?.mode).toBe("conditional");
    expect(await store.get("t2")).not.toBeUndefined();
    const t2 = await store.get("t2");
    expect(t2?.type).toBe("call");
    // D2：path 重新随机生成，不保留旧值
    expect(t2?.call?.path).not.toBe("/hooks/oldpath");
    expect(t2?.call?.path).toMatch(/^\/hooks\/[0-9a-f]{16}$/);
    const t3 = await store.get("t3");
    expect(t3?.type).toBe("system");
    expect(await store.get("t4")).toBeUndefined();
    // 旧表已删
    const leftover = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'")
      .get();
    expect(leftover).toBeUndefined();
  });
});
