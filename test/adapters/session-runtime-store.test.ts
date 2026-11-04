import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteSessionRuntimeStore } from "../../src/adapters/sqlite-session-runtime-store.js";

function entry(overrides?: Partial<{ conversationId: string; ownerId: string; port: number }>) {
  return {
    conversationId: "conv-1",
    ownerId: "user-1",
    agentId: null,
    port: 30000,
    cmd: "npm run dev -- --port 30000",
    pid: 123,
    ...overrides,
  };
}

describe("SqliteSessionRuntimeStore", () => {
  it("register 幂等：running 行原样返回，不覆盖", async () => {
    const store = new SqliteSessionRuntimeStore(new Database(":memory:"));
    store.migrate();
    const first = await store.register(entry());
    expect(first.status).toBe("running");
    expect(first.port).toBe(30000);
    const second = await store.register(entry({ port: 39999 }));
    expect(second.port).toBe(30000);
    expect(second.startedAt).toBe(first.startedAt);
  });

  it("stopped 行可覆盖重记（重启场景）", async () => {
    const store = new SqliteSessionRuntimeStore(new Database(":memory:"));
    store.migrate();
    await store.register(entry());
    await store.markStopped("conv-1");
    const again = await store.register(entry({ port: 31000 }));
    expect(again.status).toBe("running");
    expect(again.port).toBe(31000);
  });

  it("markStopped 只作用于 running 行；touch 续期", async () => {
    const store = new SqliteSessionRuntimeStore(new Database(":memory:"));
    store.migrate();
    await store.register(entry());
    expect(await store.markStopped("conv-1")).toBe(true);
    expect(await store.markStopped("conv-1")).toBe(false);
    await store.touch("conv-1", "2026-11-04T10:00:00.000Z");
    expect((await store.get("conv-1"))?.lastAccessAt).toBe("2026-11-04T10:00:00.000Z");
  });

  it("listRunning 只回 running；remove 删行；markAllStopped 清账计数", async () => {
    const store = new SqliteSessionRuntimeStore(new Database(":memory:"));
    store.migrate();
    await store.register(entry({ conversationId: "a" }));
    await store.register(entry({ conversationId: "b", ownerId: "user-2" }));
    await store.register(entry({ conversationId: "c" }));
    await store.markStopped("b");
    expect((await store.listRunning()).map((r) => r.conversationId).sort()).toEqual(["a", "c"]);
    expect(await store.markAllStopped()).toBe(2);
    expect(await store.listRunning()).toEqual([]);
    expect(await store.remove("a")).toBe(true);
    expect(await store.get("a")).toBeUndefined();
  });
});
