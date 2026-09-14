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

function fakeTranscriptStore(): TranscriptStore {
  return {
    async append() {},
    async load() {
      return null;
    },
    async listSessions() {
      return [];
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

  function mkMgr(idleHours: number): void {
    const db = new Database(":memory:");
    const packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    const csets = new SqliteCredentialSetStore(db, loadOrGenerateAppSecret(db, "k"));
    csets.migrate();
    const config: RuntimeManagerConfig = {
      workspaceDir: ws,
      llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
      sessionIdleRollHours: idleHours,
    };
    mgr = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(),
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
