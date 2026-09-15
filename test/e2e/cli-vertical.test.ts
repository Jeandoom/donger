import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CliChannel } from "../../src/adapters/cli-channel.js";
import { FakeAgentRunner, type FakeScript } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import type { SkillPack } from "../../src/domain/skill-pack.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 轮询输出直到包含 needle（带超时），用于 CLI 异步时序同步 */
async function waitFor(get: () => string, needle: string, ms = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (get().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时：未出现 "${needle}"`);
}

function setup(script: FakeScript) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (c) => {
    out += c.toString();
  });

  const store = new InMemoryTaskStore();
  const channel = new CliChannel({ input, output });
  const gates = new GateRouter();
  gates.describe({ id: "design", description: "方案审批" });
  const runner = new FakeAgentRunner(script);
  const userHome = mkdtempSync(join(tmpdir(), "donger-e2e-user-"));
  const userStore: UserStore = {
    async get() {
      return undefined;
    },
    async list() {
      return [];
    },
    async getOrCreateByIdentity(_provider, externalId, name) {
      return {
        id: `u-${externalId}`,
        name: name ?? externalId,
        role: "user" as const,
        homeDir: userHome,
        createdAt: "t",
        updatedAt: "t",
      };
    },
    async isAdminByExternalId() {
      return false;
    },
    async findByIdentity() {
      return undefined;
    },
    async addIdentity() {},
    async getIdentities() {
      return [];
    },
    async updateProfile() {},
    async updateRole() {},
    async setPasswordCredential() {},
    async getPasswordCredential() {
      return undefined;
    },
  };
  const conversationStore: import("../../src/ports/conversation-store.js").ConversationStore = {
    async create() {
      return {
        id: "conv-1",
        userId: "u",
        sdkSessionId: "",
        title: "测试",
        channelId: "cli",
        createdAt: "t",
        updatedAt: "t",
        archived: false,
      };
    },
    async get() {
      return undefined;
    },
    async getLatest() {
      return undefined;
    },
    async listByUser() {
      return [];
    },
    async update() {},
  };
  const db = new Database(":memory:");
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
  const credentialSets = new SqliteCredentialSetStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  const fakeInstaller: SkillInstaller = {
    installFromGit: async () => ({}) as SkillPack,
    installFromUpload: async () => ({}) as SkillPack,
    installFromPaste: async () => ({}) as SkillPack,
    installBuiltin: async () => ({}) as SkillPack,
    uninstall: async () => {},
    update: async () => ({}) as SkillPack,
  };
  const runtimeMgr = new RuntimeManager({
    transcriptStore: {
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
    },
    conversationStore,
    config: {
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-e2e-ws-")),
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试",
    },
    skillPackStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore,
    usageStore: new InMemoryUsageStore(),
    auditStore: new InMemoryAuditStore(),
    gates,
    runner,
    channel,
    runtimeMgr,
    credentialSets,
  });
  channel.onMessage((m) => {
    void orch.handleMessage(m);
  });
  return { input, readOut: () => out, store };
}

describe("纵切端到端（真实 CliChannel + Fake runner）", () => {
  it("消息→规划→审批门→通过→完成，任务 done", async () => {
    const { input, readOut, store } = setup({
      intro: "正在设计",
      gate: { gateId: "design", summary: "方案A" },
      outro: "已完成",
      result: "ok",
    });

    input.write("加个导出 CSV 接口\n");
    await waitFor(readOut, "通过？");
    expect(readOut()).toContain("正在设计");

    input.write("y\n");
    await waitFor(readOut, "已完成");

    expect((await store.listByStatus("done")).length).toBe(1);
  });

  it("审批驳回 → 失败", async () => {
    const { input, readOut, store } = setup({
      intro: "设计",
      gate: { gateId: "design", summary: "方案" },
    });

    input.write("实现一个接口\n");
    await waitFor(readOut, "通过？");
    input.write("n\n");
    await waitFor(readOut, "❌ 失败");

    expect((await store.listByStatus("failed")).length).toBe(1);
  });

  it("非编码消息也走 agent（通用对话）", async () => {
    const { input, readOut, store } = setup({ intro: "你好！", result: "ok" });
    input.write("今天天气怎么样\n");
    await waitFor(readOut, "你好！");
    expect((await store.listByStatus("done")).length).toBe(1);
    expect((await store.listByStatus("done")).length).toBe(1);
  });
});
