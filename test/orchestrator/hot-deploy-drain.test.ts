/**
 * 热发布优雅排水 e2e（spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M1 验收 1/2/3）
 *
 * 真实栈装配：WebChannel（HTTP+SSE，port 0）+ Orchestrator + GatedRunner（可控挂起的假引擎）
 * + DrainManager，按 index.ts 的方式接线（onMessage→handleMessage、drain hooks 回填）。
 * 验证四件事：
 *  1. 排水期在途轮零中断：排水开始→轮继续→release 后自然完成→drain 才允许退出；
 *  2. 新作业拒入：HTTP 503 draining:true（消息不落库）+ orchestrator 层拒入提示；
 *  3. SSE 收到 server_draining 广播；/api/health 排水期保持 200 且带 draining 标志；
 *  4. 排水超时兜底：markInterrupted 被调用（M2 前为 hook 桩），drain 在超时后放行退出。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { UserRole } from "../../src/domain/user.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { type DrainHooks, DrainManager } from "../../src/orchestrator/drain-manager.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../../src/ports/agent-runner.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { User, UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 可控挂起的 runner：每轮产出首个事件后等待放行（模拟长任务在途） */
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
    yield { type: "text", taskId: task.id, text: `回复：${task.prompt}` };
    await new Promise<void>((resolve) => this.gates.push(resolve));
    yield { type: "result", taskId: task.id, subtype: "success", result: `done:${task.prompt}` };
  }
}

function statefulConvStore(): ConversationStore {
  const conv = {
    id: "conv-drain",
    userId: "local",
    sdkSessionId: "",
    title: "排水测试",
    channelId: "web",
    agentId: "",
    createdAt: "t",
    updatedAt: "t",
    archived: false,
  };
  return {
    async create() {
      return conv;
    },
    async get() {
      return conv;
    },
    async getLatest() {
      return conv;
    },
    async listByUser() {
      return [conv];
    },
    async update(_id, patch) {
      Object.assign(conv, patch);
    },
  };
}

function mockUserStore(): UserStore {
  const u: User = {
    id: "local",
    name: "webu",
    role: "user" as UserRole,
    homeDir: mkdtempSync(join(tmpdir(), "donger-drain-user-")),
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

interface Harness {
  web: WebChannel;
  orch: Orchestrator;
  runner: GatedRunner;
  store: InMemoryTaskStore;
  drain: DrainManager;
  hooks: DrainHooks & {
    backgroundStopped: () => boolean;
    markInterruptedCalls: () => number;
  };
  port: number;
  close(): Promise<void>;
}

/** 按 index.ts 的装配方式搭全栈（无认证模式：不装 sessionStore） */
async function bootHarness(): Promise<Harness> {
  const runner = new GatedRunner();
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
  const convStore = statefulConvStore();
  const userStore = mockUserStore();
  const runtimeMgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore: convStore,
    config: {
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-drain-ws-")),
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });

  const drain = new DrainManager();
  let backgroundStopped = false;
  let markInterruptedCalls = 0;

  const web = new WebChannel({
    port: 0,
    workspaceDir: mkdtempSync(join(tmpdir(), "donger-drain-webroot-")),
    usageStore: new InMemoryUsageStore(),
    conversationStore: convStore,
    userStore,
    drain, // DrainManager 结构满足 WebChannelDeps["drain"]
  });
  const auditStore = new InMemoryAuditStore();
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore: convStore,
    usageStore: new InMemoryUsageStore(),
    auditStore,
    gates: createDefaultGates(),
    runner,
    channel: web,
    runtimeMgr,
    credentialSets,
    installer: fakeInstaller,
    skillPackStore: packStore,
  });
  web.onMessage((m) => void orch.handleMessage(m));
  orch.setDrainGate(drain);
  drain.setHooks({
    stopBackgroundJobs: () => {
      backgroundStopped = true;
    },
    broadcastDraining: (status) => web.broadcastDraining(status),
    activeTurnCount: () => orch.activeTurnCount(),
    queuedMessageCount: () => orch.queuedMessageCount(),
    flushQueues: (reason) => orch.flushPendingQueues(reason),
    markInterrupted: async () => {
      markInterruptedCalls += 1;
      return orch.interruptActiveTurns("服务更新排水超时");
    },
  });
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return {
    web,
    orch,
    runner,
    store,
    drain,
    hooks: {
      get backgroundStopped() {
        return backgroundStopped;
      },
      get markInterruptedCalls() {
        return markInterruptedCalls;
      },
    },
    port,
    close: () => web.stop(),
  };
}

/** SSE 订阅：后台读流，events 数组持续追加（与浏览器 EventSource 同协议） */
async function subscribeSSE(
  port: number,
  conversationId: string,
): Promise<{ events: Array<{ type: string; [k: string]: unknown }>; close(): void }> {
  const controller = new AbortController();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  void fetch(`http://127.0.0.1:${port}/api/conversations/${conversationId}/stream`, {
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data: "))
            ?.slice(6);
          if (!dataLine) continue;
          try {
            events.push(JSON.parse(dataLine) as { type: string; [k: string]: unknown });
          } catch {
            // 心跳注释行等非 JSON 帧
          }
        }
      }
    })
    .catch(() => undefined); // close() 触发 AbortError，预期
  return { events, close: () => controller.abort() };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("热发布优雅排水（M1 e2e）", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it("排水期在途轮零中断：draining 广播 → 503 拒入 → 轮完成后 drain 放行", async () => {
    h = await bootHarness();
    const sse = await subscribeSSE(h.port, "conv-drain");

    // 1. 发起长任务（GatedRunner 挂起在 gate 上）
    const send = await fetch(`http://127.0.0.1:${h.port}/api/conversations/conv-drain/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "长任务1" }),
    });
    expect(send.status).toBe(202);
    await waitFor(() => (h.runner.prompts.length === 1 ? true : undefined));

    // 2. 触发排水（等价 index.ts SIGTERM 路径）
    const draining = h.drain.beginDrain({ timeoutMs: 8000, reason: "signal:SIGTERM" });

    // 排水期：SSE 收到广播；health 保持 200 且带 draining 标志；新消息 503
    await waitFor(() => sse.events.find((e) => e.type === "server_draining"));
    const health = await fetch(`http://127.0.0.1:${h.port}/api/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { draining?: boolean }).draining).toBe(true);
    const rejected = await fetch(
      `http://127.0.0.1:${h.port}/api/conversations/conv-drain/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "排水期消息" }),
      },
    );
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("5");
    const rejectedBody = (await rejected.json()) as { draining?: boolean };
    expect(rejectedBody.draining).toBe(true);
    // 拒入发生在持久化之前：该消息不得出现在任何任务/会话处理中（runner 无新轮）
    expect(h.runner.prompts).toEqual(["长任务1"]);
    expect(h.hooks.backgroundStopped).toBe(true);

    // 3. 放行在途轮：轮自然完成 → drain 才放行退出（在途零中断）
    h.runner.release();
    await draining;
    await waitFor(async () =>
      (await h.store.listByStatus("done")).length === 1 ? true : undefined,
    );
    expect(h.hooks.markInterruptedCalls).toBe(0);

    // 4. 排水结束后新消息恢复受理（生产中排水后进程即退出；此处 reset 模拟「发布中止」恢复常态）
    h.drain.reset();
    const ok = await fetch(`http://127.0.0.1:${h.port}/api/conversations/conv-drain/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "恢复后消息" }),
    });
    expect(ok.status).toBe(202);
    await waitFor(() => (h.runner.prompts.length === 2 ? true : undefined));
    h.runner.release();
    sse.close();
  });

  it("busy 排队消息在排水期被退回（不静默丢）", async () => {
    h = await bootHarness();
    const sse = await subscribeSSE(h.port, "conv-drain");

    const p1 = h.orch.handleMessage({
      channelId: "web",
      threadId: "conv-drain",
      requesterId: "local",
      conversationId: "conv-drain",
      text: "占用会话的任务",
    });
    await waitFor(() => (h.runner.prompts.length === 1 ? true : undefined));

    // 会话 busy：第二条消息入队
    await h.orch.handleMessage({
      channelId: "web",
      threadId: "conv-drain",
      requesterId: "local",
      conversationId: "conv-drain",
      text: "排队消息",
    });
    expect(h.orch.queuedMessageCount()).toBe(1);

    // 排水：队列退回（提示经 channel.send → SSE text 事件可见）
    const draining = h.drain.beginDrain({ timeoutMs: 8000, reason: "signal:SIGTERM" });
    await waitFor(() =>
      sse.events.find((e) => e.type === "text" && String(e.text ?? "").includes("该消息未被执行")),
    );
    expect(h.orch.queuedMessageCount()).toBe(0);

    h.runner.release();
    await p1;
    await draining;
    sse.close();
  }, 15_000);

  it("排水超时兜底：markInterrupted 被调用，drain 超时后放行退出", async () => {
    h = await bootHarness();
    const sse = await subscribeSSE(h.port, "conv-drain");

    const p1 = h.orch.handleMessage({
      channelId: "web",
      threadId: "conv-drain",
      requesterId: "local",
      conversationId: "conv-drain",
      text: "超时仍挂起的任务",
    });
    await waitFor(() => (h.runner.prompts.length === 1 ? true : undefined));

    // 极短排水上限：在途轮不可能完成 → 走超时分支
    const startedAt = Date.now();
    await h.drain.beginDrain({ timeoutMs: 700, reason: "signal:SIGTERM" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    expect(h.hooks.markInterruptedCalls).toBe(1);

    // 暂停标记落库（M2）：任务行 → interrupted（非终态，重启后续跑接管）
    const running = await h.store.listByStatus("running");
    const interrupted = await h.store.listByStatus("interrupted");
    expect(running.length).toBe(0);
    expect(interrupted.length).toBe(1);
    // 会话内可见暂停提示（SSE text 事件）
    await waitFor(() =>
      sse.events.find(
        (e) => e.type === "text" && String(e.text ?? "").includes("任务已暂停"),
      ),
    );

    // 收尾：release 让挂起轮落地，避免测试遗留未消费 gate
    h.runner.release();
    await p1;
    sse.close();
  }, 15_000);
});
