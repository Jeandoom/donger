import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Conversation } from "../../src/domain/conversation.js";
import {
  RuntimeManager,
  type RuntimeManagerConfig,
} from "../../src/orchestrator/runtime-manager.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

const DAY_MS = 24 * 3_600_000;

function fakeConvStore(): ConversationStore {
  return { get: async () => undefined, update: async () => {} } as unknown as ConversationStore;
}

function fakeTranscriptStore(
  latest: { sessionId: string; mtime: number } | null = null,
): TranscriptStore {
  return {
    async append() {},
    async load() {
      return null;
    },
    async listSessions() {
      return [];
    },
    async latestSessionForConversation() {
      return latest;
    },
    async listSubkeys() {
      return [];
    },
    async delete() {},
  } as unknown as TranscriptStore;
}

const fakeInstaller: SkillInstaller = {
  installFromGit: async () => ({}) as never,
  installFromUpload: async () => ({}) as never,
  installFromPaste: async () => ({}) as never,
  installBuiltin: async () => ({}) as never,
  uninstall: async () => {},
  update: async () => ({}) as never,
};

const user = {
  id: "u1",
  name: "tester",
  role: "user" as const,
  homeDir: "",
  createdAt: "t",
  updatedAt: "t",
};

function mkConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    userId: "u1",
    sdkSessionId: "old-session",
    title: "t",
    channelId: "web",
    agentId: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
    archived: false,
    ...over,
  };
}

describe("RuntimeManager 会话空闲滚动", () => {
  let ws: string;
  let mgr: RuntimeManager;

  function mkMgr(
    idleHours: number,
    transcriptStore: TranscriptStore = fakeTranscriptStore(),
  ): void {
    const db = new Database(":memory:");
    const packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    const csets = SqliteCredentialSetStore.fromSeed(db, loadOrGenerateAppSecret(db, "k"));
    csets.migrate();
    const config: RuntimeManagerConfig = {
      workspaceDir: ws,
      llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
      sessionIdleRollHours: idleHours,
    };
    mgr = new RuntimeManager({
      transcriptStore,
      conversationStore: fakeConvStore(),
      config,
      skillPackStore: packStore,
      credentialSets: csets,
      installer: fakeInstaller,
      builtinSkillsDir: "",
    });
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-idle-"));
    user.homeDir = ws;
  });

  it("闲置超阈值：resume 不带旧 sessionId（重开新会话）", async () => {
    mkMgr(168);
    const conv = mkConv({ updatedAt: new Date(Date.now() - 9 * DAY_MS).toISOString() });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBeUndefined();
  });

  it("阈值内：照常带旧 sessionId resume", async () => {
    mkMgr(168);
    const conv = mkConv({ updatedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBe("old-session");
  });

  it("阈值 0（关闭）：闲置再久也照常 resume", async () => {
    mkMgr(0);
    const conv = mkConv({ updatedAt: new Date(Date.now() - 90 * DAY_MS).toISOString() });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBe("old-session");
  });

  it("无历史 sessionId：不受滚动影响", async () => {
    mkMgr(168);
    const conv = mkConv({ sdkSessionId: "" });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBeUndefined();
  });
});

describe("RuntimeManager resume 指针恢复", () => {
  let ws: string;
  let mgr: RuntimeManager;

  function mkMgr(
    idleHours: number,
    transcriptStore: TranscriptStore = fakeTranscriptStore(),
  ): void {
    const db = new Database(":memory:");
    const packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    const csets = SqliteCredentialSetStore.fromSeed(db, loadOrGenerateAppSecret(db, "k"));
    csets.migrate();
    const config: RuntimeManagerConfig = {
      workspaceDir: ws,
      llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
      sessionIdleRollHours: idleHours,
    };
    mgr = new RuntimeManager({
      transcriptStore,
      conversationStore: fakeConvStore(),
      config,
      skillPackStore: packStore,
      credentialSets: csets,
      installer: fakeInstaller,
      builtinSkillsDir: "",
    });
  }

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-resume-"));
    user.homeDir = ws;
  });

  it("指针为空但 store 有最近 session：反查接回（被杀轮恢复）", async () => {
    mkMgr(0, fakeTranscriptStore({ sessionId: "sess-lost", mtime: Date.now() }));
    const conv = mkConv({ sdkSessionId: "" });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBe("sess-lost");
  });

  it("指针为空且 store 无记录：不 resume（真新会话）", async () => {
    mkMgr(0);
    const conv = mkConv({ sdkSessionId: "" });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBeUndefined();
  });

  it("recoverResume=false（session 过期重试路径）：不反查，防回环", async () => {
    mkMgr(0, fakeTranscriptStore({ sessionId: "sess-expired", mtime: Date.now() }));
    const conv = mkConv({ sdkSessionId: "" });
    const { runOptions } = await mgr.prepare(user, conv, { recoverResume: false });
    expect(runOptions.resume).toBeUndefined();
  });

  it("闲置超限且指针为空：不恢复（避免复活超长上下文，与空闲滚动同语义）", async () => {
    mkMgr(168, fakeTranscriptStore({ sessionId: "sess-old", mtime: Date.now() }));
    const conv = mkConv({
      sdkSessionId: "",
      updatedAt: new Date(Date.now() - 9 * DAY_MS).toISOString(),
    });
    const { runOptions } = await mgr.prepare(user, conv, {});
    expect(runOptions.resume).toBeUndefined();
  });
});
