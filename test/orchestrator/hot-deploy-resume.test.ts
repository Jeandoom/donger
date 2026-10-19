/**
 * 中断自动续跑 e2e（spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M2 验收 4/5）
 *
 * 「新实例」语义 = 同一批 store 上另起的 Orchestrator + resume-service：
 *  1. interrupted 轮 → 合成恢复指令经 handleMessage 续跑，复用原 task 行（D3）：
 *     同 id interrupted→running→done，agent 收到的是恢复指令而非原 prompt 重放；
 *  2. 开关关闭 → 弃恢复：标 failed + 会话通知；
 *  3. 工作流运行会话（⚙️ 前缀）→ 排除续跑（防与 EventDispatcher.restore 重投双跑）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { UserRole } from "../../src/domain/user.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import {
  RESUME_SYNTHETIC_PROMPT,
  autoResumeInterruptedTasks,
} from "../../src/orchestrator/resume-service.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { Channel } from "../../src/ports/channel.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { User, UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

class GatedRunner implements AgentRunner {
  readonly prompts: string[] = [];
  private readonly gates: Array<() => void> = [];
  private sessionCounter = 0;

  release(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }

  async *run(task: Task, _opts: RunOptions, _r: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    this.sessionCounter += 1;
    yield { type: "session_init", taskId: task.id, sessionId: `sdk-${this.sessionCounter}` };
    await new Promise<void>((resolve) => this.gates.push(resolve));
    yield { type: "result", taskId: task.id, subtype: "success", result: `done:${task.id}` };
  }
}

function convStoreOf(conv: {
  id: string;
  title: string;
  channelId: string;
}): ConversationStore {
  return {
    async create() {
      return conv as never;
    },
    async get() {
      return conv as never;
    },
    async getLatest() {
      return conv as never;
    },
    async listByUser() {
      return [conv as never];
    },
    async update(_id, patch) {
      Object.assign(conv, patch);
    },
  };
}

function mockUserStore(): UserStore {
  const u: User = {
    id: "u-webu",
    name: "webu",
    role: "user" as UserRole,
    homeDir: mkdtempSync(join(tmpdir(), "donger-resume-user-")),
    createdAt: "t",
    updatedAt: "t",
  };
  return {
    async get(id) {
      return id === u.id ? u : undefined;
    },
    async list() {
      return [u];
    },
    async getOrCreateByIdentity() {
      return u;
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
    async updateSidebarPrefs() {},
    async setPasswordCredential() {},
    async getPasswordCredential() {
      return undefined;
    },
  };
}

function mockTranscriptStore(): TranscriptStore {
  return {
    async append() {},
    async load() {
      return null;
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
    async delete() {},
  };
}

class FakeMessageStore {
  readonly added: Array<{ conversationId: string; role: string; text: string }> = [];
  async add(conversationId: string, role: "user" | "bot", text: string) {
    this.added.push({ conversationId, role, text });
  }
}

function seqChannel() {
  const texts: string[] = [];
  const channel: Channel & { texts: string[] } = {
    id: "test",
    texts,
    onMessage: () => {},
    send: async (_t, m) => {
      texts.push(m.text);
    },
    requestApproval: async () => ({ approved: true }),
  };
  return channel;
}

async function build(runner: GatedRunner, conv: { id: string; title: string; channelId: string }) {
  const store = new InMemoryTaskStore();
  const db = new Database(":memory:");
  const packStore = new SqliteSkillPackStore(db);
  packStore.migrate();
  const credentialSets = SqliteCredentialSetStore.fromSeed(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialSets.migrate();
  const fakeInstaller: SkillInstaller = {
    installFromGit: async () => ({}) as never,
    installFromUpload: async () => ({}) as never,
    installFromPaste: async () => ({}) as never,
    installBuiltin: async () => ({}) as never,
    uninstall: async () => {},
    update: async () => ({}) as never,
  };
  const convStore = convStoreOf(conv);
  const runtimeMgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore: convStore,
    config: {
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-resume-ws-")),
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });
  const channel = seqChannel();
  const orch = new Orchestrator({
    store,
    userStore: mockUserStore(),
    conversationStore: convStore,
    usageStore: new InMemoryUsageStore(),
    auditStore: new InMemoryAuditStore(),
    gates: createDefaultGates(),
    runner,
    channel,
    runtimeMgr,
    credentialSets,
    // resolveAgentForUse 需要 agentStore（恢复续跑按 task.agentId 直连解析时用）
    agentStore: {
      get: async () => undefined,
      listByOwner: async () => [],
      listSharedWith: async () => [],
      listAll: async () => [],
    },
    installer: fakeInstaller,
    skillPackStore: packStore,
  });
  return { orch, store, channel };
}

function interruptedTask(id: string, threadId: string): Task {
  return {
    id,
    channelId: "web",
    threadId,
    requesterId: "u-webu",
    prompt: "原始任务：整理仓库并出报告",
    status: "interrupted",
    skillChain: [],
    createdAt: "2026-10-16T10:00:00Z",
    updatedAt: "2026-10-16T10:05:00Z",
  };
}

describe("中断自动续跑（M2 e2e）", () => {
  it("interrupted 轮复用原 task 行续跑：同 id 恢复到 done，agent 收到恢复指令而非原 prompt", async () => {
    const runner = new GatedRunner();
    const conv = { id: "conv-resume", title: "续跑测试", channelId: "web" };
    const { orch, store, channel } = await build(runner, conv);
    await store.create(interruptedTask("t-resume", "conv-resume"));
    const messages = new FakeMessageStore();

    const result = await autoResumeInterruptedTasks({
      taskStore: store,
      conversationStore: convStoreOf(conv),
      messageStore: messages as never,
      submit: (msg) => {
        void orch.handleMessage(msg).catch((e) => {
          throw e;
        });
      },
      autoResume: true,
    });
    expect(result).toMatchObject({ resumed: 1, abandoned: 0 });

    // 复用原 task 行（D3）：续跑启动即同 id 回到 running
    await vi.waitFor(async () => {
      const t = await store.get("t-resume");
      expect(t?.status).toBe("running");
    });
    // agent 输入 = 合成恢复指令（不是原 prompt 重放）
    await vi.waitFor(() => {
      expect(runner.prompts).toEqual([RESUME_SYNTHETIC_PROMPT]);
    });
    // 会话内可见「已恢复」提示
    expect(messages.added.some((m) => m.text.includes("已自动恢复"))).toBe(true);

    runner.release();
    await vi.waitFor(async () => {
      expect((await store.get("t-resume"))?.status).toBe("done");
    });
    void channel;
  });

  it("autoResume=false 时弃恢复：标 failed + 会话通知重发", async () => {
    const runner = new GatedRunner();
    const conv = { id: "conv-off", title: "开关关闭", channelId: "web" };
    const { orch, store } = await build(runner, conv);
    await store.create(interruptedTask("t-off", "conv-off"));
    const messages = new FakeMessageStore();

    const result = await autoResumeInterruptedTasks({
      taskStore: store,
      conversationStore: convStoreOf(conv),
      messageStore: messages as never,
      submit: (msg) => void orch.handleMessage(msg).catch(() => undefined),
      autoResume: false,
    });
    expect(result).toMatchObject({ resumed: 0, abandoned: 1 });
    expect((await store.get("t-off"))?.status).toBe("failed");
    expect(messages.added.some((m) => m.text.includes("请重发任务继续"))).toBe(true);
    expect(runner.prompts).toEqual([]); // 未发起任何续跑轮
  });

  it("工作流运行会话（⚙️ 前缀）被排除：不续跑防与队列重投双跑", async () => {
    const runner = new GatedRunner();
    const conv = { id: "conv-wf", title: "⚙️ 日报工作流 · 10-16 10:00", channelId: "web" };
    const { orch, store } = await build(runner, conv);
    await store.create(interruptedTask("t-wf", "conv-wf"));

    const result = await autoResumeInterruptedTasks({
      taskStore: store,
      conversationStore: convStoreOf(conv),
      submit: (msg) => void orch.handleMessage(msg).catch(() => undefined),
      autoResume: true,
    });
    expect(result).toMatchObject({ resumed: 0, abandoned: 1 });
    expect((await store.get("t-wf"))?.status).toBe("failed");
    expect(runner.prompts).toEqual([]);
  });
});
