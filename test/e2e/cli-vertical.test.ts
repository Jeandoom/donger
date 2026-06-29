import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliChannel } from "../../src/adapters/cli-channel.js";
import { FakeAgentRunner } from "../../src/adapters/fake-agent-runner.js";
import { InMemoryTaskStore } from "../../src/adapters/in-memory-task-store.js";
import { GateRouter } from "../../src/domain/gate-router.js";
import { Planner } from "../../src/domain/planner.js";
import type { User } from "../../src/domain/user.js";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { UserStore } from "../../src/ports/user-store.js";

/** 轮询输出直到包含 needle（带超时），用于 CLI 异步时序同步 */
async function waitFor(get: () => string, needle: string, ms = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (get().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时：未出现 "${needle}"`);
}

function setup(script: Parameters<typeof FakeAgentRunner>[0]) {
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
    async getOrCreate(staffId, name) {
      return {
        id: `u-${staffId}`,
        staffId,
        name,
        role: "user" as const,
        homeDir: userHome,
        createdAt: "t",
        updatedAt: "t",
      };
    },
    async get() {
      return undefined;
    },
    async getByStaffId() {
      return undefined;
    },
    async updateRole() {},
    async list() {
      return [];
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
  const orch = new Orchestrator({
    store,
    userStore,
    conversationStore,
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (_t, plan, _user: User) => ({
      cwd: ".",
      skills: plan.skills,
      llm: { model: "m", baseUrl: "u", authToken: "t" },
    }),
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
    await waitFor(readOut, "已完成");
    expect((await store.listByStatus("done")).length).toBe(1);
  });
});
