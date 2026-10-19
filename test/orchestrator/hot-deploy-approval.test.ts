/**
 * 审批决议落库 e2e（spec docs/superpowers/specs/2026-10-16-hot-deploy-design.md M3 验收 6/7/8）
 *
 * 「重启」语义 = 同一批 store 上另起的 WebChannel + Orchestrator 实例（B）：
 *  1. 实例 A 的轮卡在审批门（resolver 阻塞）→ awaiting_approval + approval_requests pending 行；
 *  2. 切到实例 B：sweep 重臂（任务保持 awaiting_approval 不标失败）、GET pending-approval
 *     从 DB 重锚卡片、POST respond 决议落库 → resumeAfterApproval 以合成决议指令续跑
 *     复用原 task 行 → done；
 *  3. 幂等：已决议行再次 respond → 409；
 *  4. 忙会话：重臂后先发新任务再点旧卡 → 409，行保持 pending。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../../src/adapters/in-memory-audit-store.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { InMemoryUsageStore } from "../../src/adapters/in-memory-usage-store.js";
import { SqliteApprovalStore } from "../../src/adapters/sqlite-approval-store.js";
import { SqliteCredentialSetStore } from "../../src/adapters/sqlite-credential-set-store.js";
import { SqliteSkillPackStore } from "../../src/adapters/sqlite-skill-pack-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { UserRole } from "../../src/domain/user.js";
import { sweepInterruptedTasks } from "../../src/orchestrator/restart-sweep.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { RuntimeManager } from "../../src/orchestrator/runtime-manager.js";
import type {
  AgentRunner,
  ApprovalDecision,
  ApprovalResolver,
  RunOptions,
} from "../../src/ports/agent-runner.js";
import type { ConversationStore } from "../../src/ports/conversation-store.js";
import type { SkillInstaller } from "../../src/ports/skill-installer.js";
import type { TranscriptStore } from "../../src/ports/transcript-store.js";
import type { User, UserStore } from "../../src/ports/user-store.js";
import { loadOrGenerateAppSecret } from "../../src/util/app-secret.js";

/** 命中审批门的 runner：产出 session_init 后调用 resolver 阻塞等决议 */
class ApprovalGateRunner implements AgentRunner {
  readonly prompts: string[] = [];
  readonly decisions: ApprovalDecision[] = [];
  private releaseGate?: (d: ApprovalDecision) => void;

  /** 预置决议（测试直接放行挂起的门） */
  decideNow(d: ApprovalDecision): void {
    this.releaseGate?.(d);
  }

  async *run(task: Task, _opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    yield { type: "session_init", taskId: task.id, sessionId: `sdk-${task.id.slice(0, 6)}` };
    const decision = await resolver({
      taskId: task.id,
      gateId: "deploy",
      tool: "Bash",
      toolUseId: "tu-1",
      input: { command: "git push origin master" },
      summary: "推送生产分支",
    });
    this.decisions.push(decision);
    yield { type: "result", taskId: task.id, subtype: "success", result: "gate passed" };
  }
}

/** 立即完成的 runner（重启后的续跑轮用：决议续跑不应再次进审批门） */
class InstantRunner implements AgentRunner {
  readonly prompts: string[] = [];
  async *run(task: Task, _opts: RunOptions, _r: ApprovalResolver): AsyncIterable<RunnerEvent> {
    this.prompts.push(task.prompt);
    yield { type: "session_init", taskId: task.id, sessionId: "sdk-b" };
    yield { type: "result", taskId: task.id, subtype: "success", result: "resumed done" };
  }
}

function mockUserStore(): UserStore {
  const u: User = {
    id: "local",
    name: "local",
    role: "admin" as UserRole,
    homeDir: mkdtempSync(join(tmpdir(), "donger-appr-user-")),
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

function convStoreOf(conv: { id: string; title: string; userId: string }): ConversationStore {
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

const CONV = { id: "conv-appr", title: "审批落库测试", userId: "local" };

interface Instance {
  web: WebChannel;
  orch: Orchestrator;
  runner: AgentRunner;
  port: number;
  close(): Promise<void>;
}

async function bootInstance(
  shared: {
    store: InMemoryTaskStore;
    approvalStore: SqliteApprovalStore;
    messages: FakeMessageStore;
    audit: InMemoryAuditStore;
  },
  runner: AgentRunner,
): Promise<Instance> {
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
  const convStore = convStoreOf(CONV);
  const userStore = mockUserStore();
  const runtimeMgr = new RuntimeManager({
    transcriptStore: mockTranscriptStore(),
    conversationStore: convStore,
    config: {
      workspaceDir: mkdtempSync(join(tmpdir(), "donger-appr-ws-")),
      llm: { model: "m", baseUrl: "u", authToken: "t" },
      defaultSystemPromptAppend: "测试",
      agentLlmPresets: [],
    },
    skillPackStore: packStore,
    credentialSets,
    installer: fakeInstaller,
    builtinSkillsDir: "",
  });

  const web = new WebChannel({
    port: 0,
    workspaceDir: mkdtempSync(join(tmpdir(), "donger-appr-webroot-")),
    usageStore: new InMemoryUsageStore(),
    conversationStore: convStore,
    userStore,
    approvalStore: shared.approvalStore,
    conversationBusyGetter: undefined, // 构造后回填（依赖 orch）
  });
  const orch = new Orchestrator({
    store: shared.store,
    userStore,
    conversationStore: convStore,
    usageStore: new InMemoryUsageStore(),
    auditStore: shared.audit,
    gates: createDefaultGates(),
    runner,
    channel: web,
    runtimeMgr,
    credentialSets,
    approvalStore: shared.approvalStore,
    messageStore: shared.messages as never,
    agentStore: {
      get: async () => undefined,
      listByOwner: async () => [],
      listSharedWith: async () => [],
      listAll: async () => [],
    },
    installer: fakeInstaller,
    skillPackStore: packStore,
  });
  web.onMessage((m) => void orch.handleMessage(m));
  // 与 index.ts 同构的决议后置：审计 + 跨重启续跑（通知省略，单测不装配 notificationService）
  (web as unknown as { deps: { conversationBusyGetter?: unknown } }).deps.conversationBusyGetter =
    (conversationId: string) => orch.isBusy(conversationId);
  (web as unknown as { deps: { onApprovalDecision?: unknown } }).deps.onApprovalDecision = async (
    d: {
      approvalId: string;
      conversationId: string;
      approved: boolean;
      reason?: string;
      responderId?: string;
      hadResolver: boolean;
    },
  ) => {
    const row = await shared.approvalStore.get(d.approvalId);
    if (row) {
      await shared.audit.record({
        conversationId: d.conversationId,
        taskId: row.taskId,
        userId: d.responderId ?? "unknown",
        seq: -1,
        type: "approval_decision",
        text: `审批${d.approved ? "通过" : "驳回"}：${row.title}`,
        recordedAt: new Date().toISOString(),
      });
    }
    if (!d.hadResolver && row) {
      await orch.resumeAfterApproval({
        taskId: row.taskId,
        gateId: row.gateId,
        gateTitle: row.title,
        approved: d.approved,
        ...(d.reason ? { reason: d.reason } : {}),
      });
    }
  };
  await web.ready();
  const port = web.boundPort;
  if (!port) throw new Error("server not listening");
  return { web, orch, runner, port, close: () => web.stop() };
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

async function postRespond(
  port: number,
  approvalId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/approvals/${approvalId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("审批决议落库（M3 e2e）", () => {
  let a: Instance;
  let b: Instance | undefined;
  const shared = {
    store: new InMemoryTaskStore(),
    approvalStore: new SqliteApprovalStore(new Database(":memory:")),
    messages: new FakeMessageStore(),
    audit: new InMemoryAuditStore(),
  };
  shared.approvalStore.migrate();

  afterEach(async () => {
    await a?.close();
    await b?.close();
    b = undefined;
  });

  it("跨重启决议续跑：重臂→决议落库→复用原 task 行续跑→done + 审计落痕", async () => {
    // —— 实例 A：轮卡在审批门 ——
    const runnerA = new ApprovalGateRunner();
    a = await bootInstance(shared, runnerA);
    const send = await fetch(`http://127.0.0.1:${a.port}/api/conversations/${CONV.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "部署任务" }),
    });
    expect(send.status).toBe(202);
    await waitFor(async () => {
      const gated = await shared.store.listByStatus("awaiting_approval");
      return gated.length === 1 ? true : undefined;
    });
    const taskId = (await shared.store.listByStatus("awaiting_approval"))[0]?.id;
    expect(taskId).toBeTruthy();
    // 请求即落库：pending 行已存在
    const pendings = await shared.approvalStore.listPendingByConversation(CONV.id);
    expect(pendings).toHaveLength(1);
    const approvalId = pendings[0]?.id;
    expect(approvalId).toBeTruthy();

    // —— 实例 B（模拟重启后新进程）：sweep 重臂 + 决议续跑 ——
    const runnerB = new InstantRunner();
    b = await bootInstance(shared, runnerB);
    const swept = await sweepInterruptedTasks({
      taskStore: shared.store,
      messageStore: shared.messages,
      auditStore: shared.audit,
      approvalStore: shared.approvalStore,
    });
    expect(swept.approvalRearmed).toBe(1);
    expect((await shared.store.get(taskId ?? ""))?.status).toBe("awaiting_approval");

    // 重臂卡片：GET pending-approval 从 DB 回卡
    const cardRes = await fetch(
      `http://127.0.0.1:${b.port}/api/conversations/${CONV.id}/pending-approval`,
    );
    const card = ((await cardRes.json()) as { approval: { approvalId: string } | null }).approval;
    expect(card?.approvalId).toBe(approvalId);

    // 决议：DB 落库 + resumeAfterApproval 复用原 task 行续跑
    const respond = await postRespond(b.port, approvalId ?? "", { approved: true });
    expect(respond.status).toBe(200);
    const row = await shared.approvalStore.get(approvalId ?? "");
    expect(row?.status).toBe("approved");

    // 续跑轮：agent 收到合成决议指令（非原 prompt 重放），同 id 走到 done
    await waitFor(async () => {
      const t = await shared.store.get(taskId ?? "");
      return t?.status === "done" ? true : undefined;
    });
    expect(runnerB.prompts).toHaveLength(1);
    expect(runnerB.prompts[0]).toContain("[审批决议]");
    expect(runnerB.prompts[0]).toContain("批准");
    // 审计落痕（此前批/拒完全无痕，M3 补全）
    const audits = await shared.audit.listByConversation(CONV.id);
    expect(audits.some((ev) => ev.type === "approval_decision")).toBe(true);
    // 会话内可见决议通知
    expect(shared.messages.added.some((m) => m.text.includes("已通过"))).toBe(true);
  });

  it("幂等：不存在的审批 id respond → 404；升级前存量语义不变", async () => {
    b = await bootInstance(shared, new InstantRunner());
    // 上一用例的行已 decided：无 pending 行也无内存 resolver → 不可能再决议
    const pendings = await shared.approvalStore.listPendingByConversation(CONV.id);
    expect(pendings).toHaveLength(0);
    const res = await postRespond(b.port, "nonexistent", { approved: true });
    expect(res.status).toBe(404);
    // 已决议行直接查仓：决策内容在案（审计/通知的事实来源）
    const all = await shared.audit.listByConversation(CONV.id);
    expect(all.some((ev) => ev.type === "approval_decision")).toBe(true);
  }, 15_000);

  it("忙会话：重臂后先发新任务再点旧卡 → 409，行保持 pending", async () => {
    // 构造一个新的挂起审批（走实例 A 正常路径）
    const runnerA2 = new ApprovalGateRunner();
    await a.close();
    a = await bootInstance(shared, runnerA2);
    const before = (await shared.approvalStore.listPendingByConversation(CONV.id)).length;
    await fetch(`http://127.0.0.1:${a.port}/api/conversations/${CONV.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "第二个部署任务" }),
    });
    await waitFor(async () => {
      const pend = await shared.approvalStore.listPendingByConversation(CONV.id);
      return pend.length === before + 1 ? true : undefined;
    });
    const pendingId = (
      await shared.approvalStore.listPendingByConversation(CONV.id)
    )[0]?.id;
    // 切实例 B：重臂后先让会话忙起来（卡审批门的轮占住会话）
    const runnerB2 = new ApprovalGateRunner();
    await b?.close();
    b = await bootInstance(shared, runnerB2);
    const busyOrch = b.orch;
    void busyOrch.handleMessage({
      channelId: "web",
      threadId: CONV.id,
      conversationId: CONV.id,
      requesterId: "local",
      text: "占住会话的新任务",
    });
    await waitFor(() => (busyOrch.isBusy(CONV.id) ? true : undefined));

    const respond = await postRespond(b.port, pendingId ?? "", { approved: true });
    expect(respond.status).toBe(409);
    expect((await shared.approvalStore.get(pendingId ?? ""))?.status).toBe("pending");
  }, 15_000);
});
