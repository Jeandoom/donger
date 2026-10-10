import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../../src/adapters/sqlite-event-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";

function fresh() {
  const db = new Database(":memory:");
  const ws = new SqliteWorkflowStore(db);
  ws.migrate();
  return { db, ws };
}

describe("SqliteWorkflowStore", () => {
  let db: Database.Database;
  let ws: SqliteWorkflowStore;

  beforeEach(() => {
    ({ db, ws } = fresh());
  });

  it("create applies defaults（enabled=false；outputSubdir 已移除）", async () => {
    const w = await ws.create({ ownerId: "u1", name: "W", eventId: "e1", agentId: "a1" });
    expect(w.promptTemplate).toBe("{{triggerOutput}}");
    expect(w.enabled).toBe(false);
    expect("outputSubdir" in w).toBe(false);
  });

  it("get + listByOwner", async () => {
    const w = await ws.create({ ownerId: "u1", name: "W", eventId: "e1", agentId: "a1" });
    expect((await ws.get(w.id))?.name).toBe("W");
    expect((await ws.listByOwner("u1")).length).toBe(1);
  });

  it("setEnabled + updateRuntimeState", async () => {
    const w = await ws.create({ ownerId: "u1", name: "W", eventId: "e1", agentId: "a1" });
    expect((await ws.setEnabled(w.id, true)).enabled).toBe(true);
    expect((await ws.get(w.id))?.enabled).toBe(true);
    await ws.updateRuntimeState(w.id, {
      lastRunId: "r1",
      lastRunAt: "2026-10-09T00:00:00Z",
      lastError: null,
    });
    const loaded = await ws.get(w.id);
    expect(loaded?.lastRunId).toBe("r1");
    expect(loaded?.lastError ?? null).toBeNull();
  });

  it("listEnabledByEvent / countEnabledByEvent / countByEventId / countByAgentId", async () => {
    const a = await ws.create({ ownerId: "u1", name: "A", eventId: "e1", agentId: "ag1" });
    await ws.create({ ownerId: "u1", name: "B", eventId: "e1", agentId: "ag2" });
    await ws.create({ ownerId: "u1", name: "C", eventId: "e2", agentId: "ag1" });
    await ws.setEnabled(a.id, true);
    expect((await ws.listEnabledByEvent("e1")).length).toBe(1);
    const counts = await ws.countEnabledByEvent();
    expect(counts.get("e1")).toBe(1);
    expect(await ws.countByEventId("e1")).toBe(2);
    expect(await ws.countByAgentId("ag1")).toBe(2);
  });

  it("update preserves id/owner/createdAt；delete removes", async () => {
    const w = await ws.create({ ownerId: "u1", name: "W", eventId: "e1", agentId: "a1" });
    const next = await ws.update(w.id, {
      name: "W2",
      promptTemplate: "Summarize: {{triggerOutput}}",
    });
    expect(next.name).toBe("W2");
    expect(next.createdAt).toBe(w.createdAt);
    await ws.delete(w.id);
    expect(await ws.get(w.id)).toBeUndefined();
  });

  it("存量库迁移：triggerId→eventId、吸收 loops 启用态与运行态、悬空订阅停用", async () => {
    const legacy = new Database(":memory:");
    // 旧 schema（workflows 无 eventId；有 outputSubdir/triggerId 及 trigger 索引）
    legacy.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        triggerId TEXT NOT NULL, agentId TEXT NOT NULL,
        promptTemplate TEXT NOT NULL, outputSubdir TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX idx_workflows_trigger ON workflows(triggerId);
      CREATE TABLE loops (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
        workflowId TEXT NOT NULL, enabled INTEGER NOT NULL,
        tags TEXT NOT NULL, lastRunId TEXT, lastRunAt TEXT, nextRunAt TEXT, lastError TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE events (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL);
    `);
    const insWf = legacy.prepare(
      "INSERT INTO workflows (id, ownerId, name, description, triggerId, agentId, promptTemplate, outputSubdir, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    // w1: 订阅仍存在的事件，被 enabled loop 引用
    insWf.run("w1", "u1", "晨报", null, "e1", "a1", "{{triggerOutput}}", "outputs/", "now", "now");
    // w2: 订阅的触发器是 git（已被事件迁移删除→悬空）
    insWf.run(
      "w2",
      "u1",
      "部署",
      null,
      "t-git",
      "a1",
      "{{triggerOutput}}",
      "outputs/",
      "now",
      "now",
    );
    legacy
      .prepare(
        "INSERT INTO loops (id, ownerId, name, workflowId, enabled, tags, lastRunId, lastRunAt, lastError, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("l1", "u1", "晨报", "w1", 1, "[]", "r9", "2026-10-01T00:00:00Z", null, "now", "now");

    legacy.prepare("INSERT INTO events (id, ownerId) VALUES (?,?)").run("e1", "u1");

    const store = new SqliteWorkflowStore(legacy);
    store.migrate();

    const w1 = await store.get("w1");
    expect(w1?.eventId).toBe("e1");
    expect(w1?.enabled).toBe(true);
    expect(w1?.lastRunId).toBe("r9");
    expect(w1?.lastRunAt).toBe("2026-10-01T00:00:00Z");
    const w2 = await store.get("w2");
    expect(w2?.eventId).toBe("t-git");
    expect(w2?.enabled).toBe(false);
    // 旧列/旧索引摘净，迁移后可直接新建（NOT NULL 约束不复现）
    const cols = (legacy.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("triggerId");
    expect(cols).not.toContain("outputSubdir");
    const idx = (legacy.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflows'").all() as Array<{ name: string }>).map((i) => i.name);
    expect(idx).not.toContain("idx_workflows_trigger");
    await expect(store.create({ ownerId: "u1", name: "新", eventId: "e1", agentId: "a1" })).resolves.toBeTruthy();
  });

  it("半迁移存量库：eventId 已在但 triggerId(NOT NULL) 未删——再次迁移幂等摘列，create 不撞约束", async () => {
    // 复现生产灾难态：上一版迁移只加列未删列，legacy 分支此后永不进入
    const half = new Database(":memory:");
    half.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        triggerId TEXT NOT NULL, agentId TEXT NOT NULL,
        promptTemplate TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        eventId TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
        lastRunId TEXT, lastRunAt TEXT, lastError TEXT
      );
      CREATE INDEX idx_workflows_trigger ON workflows(triggerId);
    `);
    half
      .prepare(
        "INSERT INTO workflows (id, ownerId, name, description, triggerId, agentId, promptTemplate, createdAt, updatedAt, eventId) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("w1", "u1", "存量", null, "e1", "a1", "{{triggerOutput}}", "now", "now", "e1");

    const store = new SqliteWorkflowStore(half);
    store.migrate();

    const cols = (half.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("triggerId");
    // 已回填的 eventId 不被覆盖
    expect((await store.get("w1"))?.eventId).toBe("e1");
    await expect(store.create({ ownerId: "u1", name: "新", eventId: "e1", agentId: "a1" })).resolves.toBeTruthy();
  });
});
