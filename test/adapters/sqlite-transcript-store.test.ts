import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTranscriptStore } from "../../src/adapters/sqlite-transcript-store.js";
import type { TranscriptEntry } from "../../src/ports/transcript-store.js";

let db: Database.Database;
let store: SqliteTranscriptStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteTranscriptStore(db);
  store.migrate();
});
afterEach(() => db.close());

const key = { projectKey: "u1", sessionId: "s1" };
const convId = "c1";

function entry(over: Partial<TranscriptEntry> & { type: string }): TranscriptEntry {
  return { timestamp: "2026-07-08T00:00:00.000Z", ...over };
}

describe("SqliteTranscriptStore", () => {
  it("migrate 幂等", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("append + load 往返，保持顺序", async () => {
    await store.append(key, convId, [
      entry({ type: "user", uuid: "a1", message: "hi" }),
      entry({ type: "assistant", uuid: "a2", message: "yo" }),
    ]);
    const got = await store.load(key);
    expect(got?.length).toBe(2);
    expect(got?.[0]?.uuid).toBe("a1");
    expect(got?.[1]?.uuid).toBe("a2");
    // 原始 payload 透传
    expect(got?.[0]?.message).toBe("hi");
  });

  it("append 幂等：重复 uuid 不重复入库", async () => {
    const e = entry({ type: "user", uuid: "dup", message: "x" });
    await store.append(key, convId, [e]);
    await store.append(key, convId, [e]);
    const got = await store.load(key);
    expect(got?.length).toBe(1);
  });

  it("无 uuid 的条目按 append 顺序插入（不幂等丢失）", async () => {
    await store.append(key, convId, [
      entry({ type: "title", message: "t1" }),
      entry({ type: "title", message: "t2" }),
    ]);
    const got = await store.load(key);
    expect(got?.length).toBe(2);
  });

  it("load 未写入的 key 返回 null", async () => {
    expect(await store.load({ projectKey: "u1", sessionId: "nope" })).toBeNull();
  });

  it("subpath 隔离主 transcript 与子 agent", async () => {
    await store.append(key, convId, [entry({ type: "user", uuid: "main1" })]);
    await store.append({ ...key, subpath: "agent-x" }, convId, [
      entry({ type: "user", uuid: "sub1" }),
    ]);
    const main = await store.load(key);
    const sub = await store.load({ ...key, subpath: "agent-x" });
    expect(main?.[0]?.uuid).toBe("main1");
    expect(sub?.[0]?.uuid).toBe("sub1");
  });

  it("listSessions 返回会话与 mtime", async () => {
    await store.append({ projectKey: "u1", sessionId: "s1" }, convId, [
      entry({ type: "user", uuid: "a", timestamp: "2026-07-08T00:00:00.000Z" }),
    ]);
    await store.append({ projectKey: "u1", sessionId: "s2" }, "c2", [
      entry({ type: "user", uuid: "b", timestamp: "2026-07-09T00:00:00.000Z" }),
    ]);
    const list = await store.listSessions("u1");
    expect(list.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("listSessions 按 projectKey 过滤", async () => {
    await store.append({ projectKey: "u1", sessionId: "s1" }, convId, [
      entry({ type: "user", uuid: "a" }),
    ]);
    await store.append({ projectKey: "u2", sessionId: "s2" }, "c2", [
      entry({ type: "user", uuid: "b" }),
    ]);
    expect(await store.listSessions("u1")).toHaveLength(1);
  });

  it("listSubkeys 返回子 agent subpath", async () => {
    await store.append({ ...key, subpath: "agent-x" }, convId, [
      entry({ type: "user", uuid: "1" }),
    ]);
    await store.append({ ...key, subpath: "agent-y" }, convId, [
      entry({ type: "user", uuid: "2" }),
    ]);
    const subs = await store.listSubkeys(key);
    expect(subs.sort()).toEqual(["agent-x", "agent-y"]);
  });

  it("latestSessionForConversation 返回最近一次 session", async () => {
    await store.append({ projectKey: "u1", sessionId: "s1" }, convId, [
      entry({ type: "user", uuid: "a", timestamp: "2026-07-08T00:00:00.000Z" }),
    ]);
    await store.append({ projectKey: "u1", sessionId: "s2" }, convId, [
      entry({ type: "user", uuid: "b", timestamp: "2026-07-09T00:00:00.000Z" }),
    ]);
    const latest = await store.latestSessionForConversation(convId);
    expect(latest?.sessionId).toBe("s2");
  });

  it("latestSessionForConversation 只看主 transcript，按会话隔离，无记录返回 null", async () => {
    await store.append(key, convId, [entry({ type: "user", uuid: "main" })]);
    await store.append({ ...key, sessionId: "s-sub", subpath: "agent-x" }, convId, [
      entry({ type: "user", uuid: "sub", timestamp: "2026-07-09T00:00:00.000Z" }),
    ]);
    await store.append({ projectKey: "u1", sessionId: "s-other" }, "c2", [
      entry({ type: "user", uuid: "o", timestamp: "2026-07-10T00:00:00.000Z" }),
    ]);
    const latest = await store.latestSessionForConversation(convId);
    expect(latest?.sessionId).toBe("s1");
    expect(await store.latestSessionForConversation("c-none")).toBeNull();
  });

  it("delete 清理主 transcript 与子 agent", async () => {
    await store.append(key, convId, [entry({ type: "user", uuid: "m" })]);
    await store.append({ ...key, subpath: "agent-x" }, convId, [
      entry({ type: "user", uuid: "s" }),
    ]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load({ ...key, subpath: "agent-x" })).toBeNull();
  });
});
