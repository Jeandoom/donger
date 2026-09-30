import { afterEach, describe, expect, it, vi } from "vitest";
import { GitWatcher } from "../../src/orchestrator/git-watcher.js";
import type { LoopRunner } from "../../src/orchestrator/loop-runner.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { GitPlatformApi } from "../../src/ports/git-platform-api.js";
import type { Loop, LoopStore } from "../../src/ports/loop-store.js";
import type { Trigger, TriggerStore } from "../../src/ports/trigger-store.js";
import type { Workflow, WorkflowStore } from "../../src/ports/workflow-store.js";
import type { Logger } from "../../src/util/logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function makeDeps(headBody: string, headOk = true) {
  const triggers = new Map<string, Trigger>();
  const workflows = new Map<string, Workflow>();
  const loops = new Map<string, Loop>();
  const lastSha = new Map<string, string>();
  const fired: Array<{
    loopId: string;
    sourceOutput: string;
    eventName?: string;
    triggerId?: string;
  }> = [];

  const triggerStore = {
    get: async (id: string) => triggers.get(id),
    getGitLastSha: async (id: string) => lastSha.get(id),
    setGitLastSha: async (id: string, sha: string) => {
      lastSha.set(id, sha);
    },
  } as unknown as TriggerStore;
  const workflowStore = {
    get: async (id: string) => workflows.get(id),
  } as unknown as WorkflowStore;
  const loopStore = {
    listEnabled: async () => [...loops.values()].filter((l) => l.enabled),
  } as unknown as LoopStore;
  const loopRunner = {
    fire: async (loopId: string, sourceOutput: string, eventName?: string, triggerId?: string) => {
      fired.push({ loopId, sourceOutput, eventName, triggerId });
    },
  } as unknown as LoopRunner;
  const credentialSets = {
    getFilledValues: async (_uid: string, codes: string[]) =>
      codes.map((code) => ({ code, values: { access_token: "tok" } })),
  } as unknown as CredentialSetStore;
  const platformApis = () =>
    ({
      getBranch: async () => ({ ok: headOk, status: headOk ? 200 : 404, body: headBody }),
    }) as unknown as GitPlatformApi;

  const watcher = new GitWatcher({
    triggerStore,
    workflowStore,
    loopStore,
    loopRunner,
    credentialSets,
    platformApis,
    logger,
  });
  return { watcher, triggers, workflows, loops, lastSha, fired, triggerStore };
}

function gitTrigger(overrides: Partial<Trigger["git"]> = {}): Trigger["git"] {
  return {
    provider: "gitee",
    repoUrl: "https://gitee.com/o/r.git",
    branch: "master",
    credentialCode: "gitee-pat",
    ...overrides,
  };
}

describe("GitWatcher（git 触发器看护）", () => {
  it("首见：建立基线不触发", async () => {
    const ctx = makeDeps(JSON.stringify({ commit: { sha: "aaaa1111" } }));
    ctx.triggers.set("t1", {
      id: "t1",
      ownerId: "u1",
      name: "watch",
      type: "git",
      git: gitTrigger(),
      createdAt: "t",
      updatedAt: "t",
    } as Trigger);
    ctx.workflows.set("w1", { id: "w1", name: "w", triggerId: "t1" } as Workflow);
    ctx.loops.set("l1", {
      id: "l1",
      ownerId: "u1",
      name: "loop",
      workflowId: "w1",
      enabled: true,
      tags: [],
    } as unknown as Loop);
    await ctx.watcher.watchOnce();
    expect(ctx.fired).toHaveLength(0);
    expect(ctx.lastSha.get("t1")).toBe("aaaa1111");
  });

  it("新提交：fire 全部绑定 enabled loop，sourceOutput 带 previousSha/sha", async () => {
    const ctx = makeDeps(JSON.stringify({ commit: { sha: "bbbb2222" } }));
    ctx.triggers.set("t1", {
      id: "t1",
      ownerId: "u1",
      name: "watch",
      type: "git",
      git: gitTrigger(),
      createdAt: "t",
      updatedAt: "t",
    } as Trigger);
    ctx.workflows.set("w1", { id: "w1", name: "w", triggerId: "t1" } as Workflow);
    ctx.loops.set("l1", {
      id: "l1",
      ownerId: "u1",
      name: "loop1",
      workflowId: "w1",
      enabled: true,
      tags: [],
    } as unknown as Loop);
    ctx.loops.set("l2", {
      id: "l2",
      ownerId: "u1",
      name: "loop2",
      workflowId: "w1",
      enabled: false,
      tags: [],
    } as unknown as Loop);
    ctx.lastSha.set("t1", "aaaa1111");
    await ctx.watcher.watchOnce();
    expect(ctx.fired).toHaveLength(1); // disabled loop 不触发
    expect(ctx.fired[0]?.loopId).toBe("l1");
    expect(ctx.fired[0]?.eventName).toBe("git");
    const out = JSON.parse(ctx.fired[0]?.sourceOutput ?? "{}");
    expect(out.sha).toBe("bbbb2222");
    expect(out.previousSha).toBe("aaaa1111");
    expect(ctx.lastSha.get("t1")).toBe("bbbb2222");
  });

  it("无变化 / HEAD 失败：均不触发", async () => {
    const setup = (ctx: ReturnType<typeof makeDeps>, lastSha: string | undefined) => {
      ctx.triggers.set("t1", {
        id: "t1",
        ownerId: "u1",
        name: "watch",
        type: "git",
        git: gitTrigger(),
        createdAt: "t",
        updatedAt: "t",
      } as Trigger);
      ctx.workflows.set("w1", { id: "w1", name: "w", triggerId: "t1" } as Workflow);
      ctx.loops.set("l1", {
        id: "l1",
        ownerId: "u1",
        name: "loop",
        workflowId: "w1",
        enabled: true,
        tags: [],
      } as unknown as Loop);
      if (lastSha) ctx.lastSha.set("t1", lastSha);
    };
    // 无变化
    const same = makeDeps(JSON.stringify({ commit: { sha: "aaaa1111" } }));
    setup(same, "aaaa1111");
    await same.watcher.watchOnce();
    // HEAD 查询失败（HTTP 404）
    const failing = makeDeps("{}", false);
    setup(failing, "aaaa1111");
    await failing.watcher.watchOnce();
    expect([...same.fired, ...failing.fired]).toHaveLength(0);
  });

  it("fetchHead：gitee/github 用 commit.sha、gitlab 用 commit.id、坏 body 报错", async () => {
    const ctx = makeDeps("{}");
    expect((await ctx.watcher.fetchHead(gitTrigger(), "u1")).sha).toBeUndefined(); // 坏 body
    const gitee = makeDeps(JSON.stringify({ commit: { sha: "cccc3333" } }));
    expect((await gitee.watcher.fetchHead(gitTrigger(), "u1")).sha).toBe("cccc3333");
    const gitlab = makeDeps(JSON.stringify({ commit: { id: "dddd4444" } }));
    expect(
      (
        await gitlab.watcher.fetchHead(
          gitTrigger({ provider: "jihulab", repoUrl: "https://jihulab.com/a/b.git" }),
          "u1",
        )
      ).sha,
    ).toBe("dddd4444");
  });
});
