import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteTriggerStore } from "../../src/adapters/sqlite-trigger-store.js";

function newStore() {
  const db = new Database(":memory:");
  const ts = new SqliteTriggerStore(db);
  ts.migrate();
  // 手建 workflows 表以验证 countWorkflowsReferencing（实际由 SqliteWorkflowStore.migrate 创建）
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, ownerId TEXT, name TEXT, triggerId TEXT, agentId TEXT,
      promptTemplate TEXT, outputSubdir TEXT, description TEXT,
      createdAt TEXT, updatedAt TEXT
    )
  `);
  return { db, ts };
}

describe("SqliteTriggerStore", () => {
  it("create + get roundtrip", async () => {
    const { ts } = newStore();
    const t = await ts.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "http", url: "https://x", method: "GET" },
        matcher: { kind: "always" },
      },
    });
    expect(t.id).toBeTruthy();
    expect((await ts.get(t.id))?.name).toBe("T");
  });

  it("findByHookPath", async () => {
    const { ts } = newStore();
    await ts.create({
      ownerId: "u1",
      name: "H",
      type: "hook",
      hook: {
        path: "/hooks/dt",
        responseStatus: 200,
        responseBody: "ok",
        matcher: { kind: "always" },
      },
    });
    expect((await ts.findByHookPath("/hooks/dt"))?.name).toBe("H");
    expect(await ts.findByHookPath("/hooks/missing")).toBeUndefined();
  });

  it("listByOwner filters", async () => {
    const { ts } = newStore();
    await ts.create({
      ownerId: "u1",
      name: "A",
      type: "scheduler",
      scheduler: {
        cron: "*/5 * * * *",
        source: { type: "file", path: "/tmp/x" },
        matcher: { kind: "always" },
      },
    });
    await ts.create({
      ownerId: "u2",
      name: "B",
      type: "scheduler",
      scheduler: {
        cron: "*/5 * * * *",
        source: { type: "file", path: "/tmp/y" },
        matcher: { kind: "always" },
      },
    });
    expect((await ts.listByOwner("u1")).length).toBe(1);
  });

  it("countWorkflowsReferencing", async () => {
    const { ts, db } = newStore();
    const t = await ts.create({
      ownerId: "u1",
      name: "T",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    expect(await ts.countWorkflowsReferencing(t.id)).toBe(0);
    db.prepare(
      "INSERT INTO workflows (id, ownerId, name, triggerId, agentId, promptTemplate, outputSubdir, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("w1", "u1", "W", t.id, "a1", "{{triggerOutput}}", "outputs/", "now", "now");
    expect(await ts.countWorkflowsReferencing(t.id)).toBe(1);
  });

  it("delete removes row", async () => {
    const { ts } = newStore();
    const t = await ts.create({
      ownerId: "u1",
      name: "X",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    await ts.delete(t.id);
    expect(await ts.get(t.id)).toBeUndefined();
  });

  it("update changes name and matcher", async () => {
    const { ts } = newStore();
    const t = await ts.create({
      ownerId: "u1",
      name: "X",
      type: "scheduler",
      scheduler: {
        cron: "* * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "always" },
      },
    });
    const next = await ts.update(t.id, {
      name: "X2",
      scheduler: {
        cron: "0 * * * *",
        source: { type: "file", path: "/x" },
        matcher: { kind: "bodyContains", keyword: "err" },
      },
    });
    expect(next.name).toBe("X2");
    expect(next.scheduler?.cron).toBe("0 * * * *");
    expect((await ts.get(t.id))?.scheduler?.matcher.kind).toBe("bodyContains");
  });
});
