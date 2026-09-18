import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";

function newStore() {
  const db = new Database(":memory:");
  const ws = new SqliteWorkflowStore(db);
  ws.migrate();
  return { db, ws };
}

describe("SqliteWorkflowStore", () => {
  it("create applies defaults", async () => {
    const { ws } = newStore();
    const w = await ws.create({ ownerId: "u1", name: "W", triggerId: "t1", agentId: "a1" });
    expect(w.promptTemplate).toBe("{{triggerOutput}}");
    expect(w.outputSubdir).toBe("outputs/");
    expect(w.id).toBeTruthy();
  });

  it("get + listByOwner", async () => {
    const { ws } = newStore();
    const w = await ws.create({ ownerId: "u1", name: "W", triggerId: "t1", agentId: "a1" });
    expect((await ws.get(w.id))?.name).toBe("W");
    expect((await ws.listByOwner("u1")).length).toBe(1);
  });

  it("update preserves id/owner/createdAt", async () => {
    const { ws } = newStore();
    const w = await ws.create({ ownerId: "u1", name: "W", triggerId: "t1", agentId: "a1" });
    const next = await ws.update(w.id, {
      name: "W2",
      promptTemplate: "Summarize: {{triggerOutput}}",
    });
    expect(next.name).toBe("W2");
    expect(next.promptTemplate).toBe("Summarize: {{triggerOutput}}");
    expect(next.createdAt).toBe(w.createdAt);
  });

  it("delete removes", async () => {
    const { ws } = newStore();
    const w = await ws.create({ ownerId: "u1", name: "W", triggerId: "t1", agentId: "a1" });
    await ws.delete(w.id);
    expect(await ws.get(w.id)).toBeUndefined();
  });
});
