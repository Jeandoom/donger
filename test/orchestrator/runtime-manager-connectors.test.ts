import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteConnectorStore } from "../../src/adapters/sqlite-connector-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { Agent } from "../../src/domain/agent.js";
import type { Conversation } from "../../src/domain/conversation.js";
import {
  RuntimeManager,
  type RuntimeManagerConfig,
} from "../../src/orchestrator/runtime-manager.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

function fakeConvStore(): ConversationStore {
  const conv: Conversation = {
    id: "c1",
    userId: "u1",
    sdkSessionId: "",
    title: "t",
    channelId: "web",
    agentId: "",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    archived: false,
  };
  return {
    async get() {
      return conv;
    },
    async update() {},
    snapshot: () => conv,
  } as unknown as ConversationStore;
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

const mkAgent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1",
  ownerId: "u1",
  name: "ag",
  skills: [],
  tools: { mode: "all", whitelist: [] },
  mcpServers: [{ name: "inline", type: "http", url: "https://inline/mcp" }],
  connectorIds: [],
  credentials: [],
  gitRepositories: [],
  gitAllowShellGit: false,
  extensionDirectories: [],
  acceptanceGate: false,
  llm: {},
  version: 1,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("RuntimeManager 连接器注入", () => {
  let ws: string;
  let mgr: RuntimeManager;
  let cstore: SqliteConnectorStore;
  let csets: SqliteCredentialSetStore;
  const user = {
    id: "u1",
    name: "tester",
    role: "user" as const,
    homeDir: "",
    createdAt: "t",
    updatedAt: "t",
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rtmgr-conn-"));
    user.homeDir = ws;
    const db = new Database(":memory:");
    const packStore = new SqliteSkillPackStore(db);
    packStore.migrate();
    csets = new SqliteCredentialSetStore(db, loadOrGenerateAppSecret(db, "k"));
    csets.migrate();
    cstore = new SqliteConnectorStore(db, createSecretCipher("conn-seed"));
    cstore.migrate();
    const config: RuntimeManagerConfig = {
      workspaceDir: ws,
      llm: { model: "glm", baseUrl: "http://x", authToken: "t" },
      defaultSystemPromptAppend: "",
      agentLlmPresets: [],
    };
    mgr = new RuntimeManager({
      transcriptStore: fakeTranscriptStore(),
      conversationStore: fakeConvStore(),
      config,
      skillPackStore: packStore,
      credentialSets: csets,
      connectorStore: cstore,
      installer: fakeInstaller,
      builtinSkillsDir: "",
    });
  });

  const conv = { id: "c1" } as Conversation;

  it("prepare：勾选连接器解析为 http mcpServers，凭证引用按访问者替换", async () => {
    await csets.createTemplate("amap", { name: "amap", keySpecs: [{ key: "token" }] }, "u1");
    await csets.upsertValue("u1", "amap", { token: "live-key" });
    const c = await cstore.create(
      {
        name: "amap-conn",
        url: "https://mcp.amap.com/mcp",
        headers: { Authorization: "Bearer {{credential:amap.token}}" },
      },
      "u1",
    );
    const { runOptions } = await mgr.prepare(user, conv, {
      agent: mkAgent({ connectorIds: [c.id] }),
    });
    const server = runOptions.mcpServers?.find((s) => s.name === "amap-conn");
    expect(server).toMatchObject({ type: "http", url: "https://mcp.amap.com/mcp" });
    expect(server?.headers?.Authorization).toBe("Bearer live-key");
  });

  it("停用与他人 private 的连接器被跳过", async () => {
    const disabled = await cstore.create(
      { name: "off", url: "https://off/mcp", enabled: false },
      "u1",
    );
    const othersPrivate = await cstore.create({ name: "hidden", url: "https://h/mcp" }, "someone");
    const { runOptions } = await mgr.prepare(user, conv, {
      agent: mkAgent({ connectorIds: [disabled.id, othersPrivate.id] }),
    });
    expect(runOptions.mcpServers?.some((s) => s.name === "off")).toBe(false);
    expect(runOptions.mcpServers?.some((s) => s.name === "hidden")).toBe(false);
  });

  it("重名兜底：连接器优先，内联同名被丢弃", async () => {
    const c = await cstore.create({ name: "inline", url: "https://connector/mcp" }, "u1");
    const { runOptions } = await mgr.prepare(user, conv, {
      agent: mkAgent({ connectorIds: [c.id] }),
    });
    const same = runOptions.mcpServers?.filter((s) => s.name === "inline");
    expect(same).toHaveLength(1);
    expect(same?.[0]?.url).toBe("https://connector/mcp");
    expect(runOptions.mcpServers?.map((s) => s.name)).toContain("inline");
  });

  it("凭证未配置：引用头剔除，其余头保留", async () => {
    const c = await cstore.create(
      {
        name: "partial",
        url: "https://p/mcp",
        headers: { Authorization: "{{credential:none}}", "X-Ok": "keep" },
      },
      "u1",
    );
    const { runOptions } = await mgr.prepare(user, conv, {
      agent: mkAgent({ connectorIds: [c.id] }),
    });
    const server = runOptions.mcpServers?.find((s) => s.name === "partial");
    expect(server?.headers).toEqual({ "X-Ok": "keep" });
  });

  it("connectorCredentialCodes：收集可见+enabled 连接器的引用 code", async () => {
    const a = await cstore.create(
      { name: "a", url: "https://a/mcp", headers: { A: "{{credential:c1}}" } },
      "u1",
    );
    const b = await cstore.create(
      { name: "b", url: "https://b/mcp", headers: { B: "{{credential:c2}}" }, enabled: false },
      "u1",
    );
    const hidden = await cstore.create(
      { name: "h", url: "https://h/mcp", headers: { H: "{{credential:c3}}" } },
      "someone",
    );
    const codes = await mgr.connectorCredentialCodes(user.id, [a.id, b.id, hidden.id]);
    expect(codes).toEqual(["c1"]);
  });
});
