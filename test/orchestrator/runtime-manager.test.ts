import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Conversation } from "../../src/domain/conversation.js";
import type { User } from "../../src/domain/user.js";
import {
  RuntimeManager,
  type RuntimeManagerConfig,
} from "../../src/orchestrator/runtime-manager.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";

/** 内存 ConversationStore */
function fakeConvStore(initial: Conversation[] = []) {
  const map = new Map(initial.map((c) => [c.id, c]));
  return {
    async get(id: string) {
      return map.get(id);
    },
    async update(id: string, patch: Partial<Conversation>) {
      const c = map.get(id);
      if (c) map.set(id, { ...c, ...patch, updatedAt: new Date().toISOString() });
    },
    snapshot: (id: string) => map.get(id),
  };
}

/** 内存 TranscriptStore（只够 getTranscript 用） */
function fakeTranscriptStore(loadImpl: (key: { sessionId: string }) => unknown): TranscriptStore {
  return {
    async append() {},
    async load(key) {
      return loadImpl(key) as never;
    },
    async listSessions() {
      return [];
    },
    async listSubkeys() {
      return [];
    },
    async delete() {},
  };
}

const baseConv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  userId: "u1",
  sdkSessionId: "",
  title: "t",
  channelId: "web",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
  archived: false,
  ...over,
});

const baseUser = (homeDir: string): User => ({
  id: "u1",
  name: "tester",
  role: "user",
  homeDir,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
});

const baseConfig = (
  ws: string,
  over: Partial<RuntimeManagerConfig> = {},
): RuntimeManagerConfig => ({
  workspaceDir: ws,
  llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
  defaultPluginPaths: [],
  defaultSystemPromptAppend: "高危操作触发审批门。",
  ...over,
});

describe("RuntimeManager", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-"));
  });

  it("prepare：新会话(无 sdkSessionId)产出含 sessionStore + 空 resume + 正确 runtimeDir", async () => {
    const conv = baseConv();
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    const { context, runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {
      plan: { intent: "code", skills: ["s1"] },
    });
    expect(context.sdkSessionId).toBe("");
    expect(runOptions.resume).toBeUndefined();
    expect(runOptions.sessionStore).toBeDefined();
    expect(runOptions.cwd).toContain("sessions");
    expect(runOptions.cwd).toContain("c1");
    // 无 superpowers → skills 不启用（沿用原 runOptsFor 语义）
    expect(runOptions.skills).toEqual([]);
    // pluginPaths 含每用户 .skills/
    expect(runOptions.pluginPaths?.some((p) => p.endsWith(".skills"))).toBe(true);
  });

  it("prepare：配置 superpowers 时启用 plan.skills", async () => {
    const conv = baseConv();
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws, { superpowersPluginPath: "/opt/superpowers" }),
    });
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {
      plan: { intent: "code", skills: ["superpowers:brainstorming"] },
    });
    expect(runOptions.skills).toEqual(["superpowers:brainstorming"]);
    expect(runOptions.pluginPaths).toContain("/opt/superpowers");
  });

  it("prepare：续接会话(有 sdkSessionId)产出 resume", async () => {
    const conv = baseConv({ sdkSessionId: "sdk-xyz" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    const { runOptions } = await m.prepare(baseUser(join(ws, "users", "u1")), conv, {});
    expect(runOptions.resume).toBe("sdk-xyz");
  });

  it("commit：回写 sdkSessionId 到 ConversationStore", async () => {
    const conv = baseConv();
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    await m.commit("c1", { sdkSessionId: "sdk-new" });
    expect(convStore.snapshot("c1")?.sdkSessionId).toBe("sdk-new");
  });

  it("clearResume：清空 sdkSessionId（session 过期重试用）", async () => {
    const conv = baseConv({ sdkSessionId: "stale" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    await m.clearResume("c1");
    expect(convStore.snapshot("c1")?.sdkSessionId).toBe("");
  });

  it("getTranscript：按 conversationId 读 transcript（经 sdkSessionId）", async () => {
    const conv = baseConv({ sdkSessionId: "sdk-1" });
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore((key) =>
        key.sessionId === "sdk-1" ? [{ type: "user", uuid: "m1", message: "hi" }] : null,
      ),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    const msgs = await m.getTranscript("c1");
    expect(msgs?.length).toBe(1);
    expect(msgs?.[0]?.uuid).toBe("m1");
  });

  it("getTranscript：无 sdkSessionId 返回 null", async () => {
    const conv = baseConv();
    const convStore = fakeConvStore([conv]);
    const m = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(() => null),
      conversationStore: convStore as unknown as ConversationStore,
      config: baseConfig(ws),
    });
    expect(await m.getTranscript("c1")).toBeNull();
  });
});
