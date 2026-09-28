import { describe, expect, it } from "vitest";
import { SdkSessionStoreAdapter } from "../../src/adapters/sdk-session-store.js";
import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptStore,
} from "../../src/ports/transcript-store.js";

/** 内存版 TranscriptStore，仅测试用 */
function memStore(): TranscriptStore & { dump: (k: TranscriptKey) => TranscriptEntry[] } {
  const map = new Map<string, TranscriptEntry[]>();
  const k = (key: TranscriptKey) => `${key.projectKey}|${key.sessionId}|${key.subpath ?? ""}`;
  return {
    async append(key, _convId, entries) {
      const arr = map.get(k(key)) ?? [];
      const seen = new Set(arr.filter((e) => e.uuid).map((e) => e.uuid));
      for (const e of entries) {
        if (e.uuid && seen.has(e.uuid)) continue;
        if (e.uuid) seen.add(e.uuid);
        arr.push(e);
      }
      map.set(k(key), arr);
    },
    async load(key) {
      return map.get(k(key)) ?? null;
    },
    async listSessions() {
      return [];
    },
    async latestSessionForConversation() {
      return null;
    },
    async listSubkeys() {
      return [];
    },
    async delete(key) {
      map.delete(k(key));
    },
    dump: (key: TranscriptKey) => map.get(k(key)) ?? [],
  };
}

describe("SdkSessionStoreAdapter", () => {
  it("append 把 SDK SessionKey 翻译为 TranscriptKey 并透传条目", async () => {
    const inner = memStore();
    const adapter = new SdkSessionStoreAdapter(inner, () => "c1");
    await adapter.append({ projectKey: "u1", sessionId: "s1" }, [
      { type: "user", uuid: "x1", message: "hi" },
    ]);
    expect(inner.dump({ projectKey: "u1", sessionId: "s1" }).length).toBe(1);
  });

  it("append 带 subpath 时透传到子 agent transcript", async () => {
    const inner = memStore();
    const adapter = new SdkSessionStoreAdapter(inner, () => "c1");
    await adapter.append({ projectKey: "u1", sessionId: "s1", subpath: "agent-x" }, [
      { type: "user", uuid: "s1" },
    ]);
    expect(inner.dump({ projectKey: "u1", sessionId: "s1", subpath: "agent-x" }).length).toBe(1);
    expect(inner.dump({ projectKey: "u1", sessionId: "s1" }).length).toBe(0);
  });

  it("load 返回 TranscriptStore 内容（null 透传）", async () => {
    const inner = memStore();
    const adapter = new SdkSessionStoreAdapter(inner, () => "c1");
    expect(await adapter.load({ projectKey: "u1", sessionId: "none" })).toBeNull();
    await adapter.append({ projectKey: "u1", sessionId: "s1" }, [
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
    const got = await adapter.load({ projectKey: "u1", sessionId: "s1" });
    expect(got?.length).toBe(2);
  });

  it("conversationIdResolver 决定 conv_id 落库", async () => {
    const inner = memStore();
    let capturedConvId = "";
    const innerSpy: TranscriptStore = {
      ...inner,
      async append(key, convId, entries) {
        capturedConvId = convId;
        return inner.append(key, convId, entries);
      },
    };
    const adapter = new SdkSessionStoreAdapter(innerSpy, (key) =>
      key.sessionId === "s1" ? "conv-1" : "conv-?",
    );
    await adapter.append({ projectKey: "u1", sessionId: "s1" }, [{ type: "user", uuid: "a" }]);
    expect(capturedConvId).toBe("conv-1");
  });

  it("listSubkeys 透传", async () => {
    const inner = memStore();
    let listed = false;
    const innerSpy: TranscriptStore = {
      ...inner,
      async listSubkeys() {
        listed = true;
        return ["agent-x"];
      },
    };
    const adapter = new SdkSessionStoreAdapter(innerSpy, () => "c1");
    const subs = await adapter.listSubkeys?.({ projectKey: "u1", sessionId: "s1" });
    expect(listed).toBe(true);
    expect(subs).toEqual(["agent-x"]);
  });

  it("delete 透传", async () => {
    const inner = memStore();
    const adapter = new SdkSessionStoreAdapter(inner, () => "c1");
    await adapter.append({ projectKey: "u1", sessionId: "s1" }, [{ type: "user", uuid: "a" }]);
    await adapter.delete?.({ projectKey: "u1", sessionId: "s1" });
    expect(await adapter.load({ projectKey: "u1", sessionId: "s1" })).toBeNull();
  });
});
