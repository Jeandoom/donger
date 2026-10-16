import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent.js";
import type { Feedback, FeedbackStatus } from "../../src/domain/feedback.js";
import type { Workflow } from "../../src/domain/workflow.js";
import type { AgentStore } from "../../src/ports/agent-store.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { FeedbackStore } from "../../src/ports/feedback-store.js";
import type {
  GitPlatformApi,
  GitPlatformApiResolver,
  PlatformApiResult,
} from "../../src/ports/git-platform-api.js";
import type { RateLimiter } from "../../src/ports/rate-limiter.js";
import type { ReleaseRun, ReleaseRunStore } from "../../src/ports/release-run-store.js";
import type { WorkflowStore } from "../../src/ports/workflow-store.js";
import { ReleaseService } from "../../src/orchestrator/release-service.js";

const okJson = (body: unknown): PlatformApiResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(body),
});

const REPO_PATH = "owner/donger";

function makeWorkflow(autoDev = { enabled: true, policy: {} }): Workflow {
  return {
    id: "wf-1",
    ownerId: "admin-1",
    name: "反馈自动修复",
    eventId: "evt-1",
    agentId: "agent-1",
    permissionMode: "full_access",
    promptTemplate: "{{triggerOutput}}",
    enabled: true,
    autoDev,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  } as unknown as Workflow;
}

function makeAgent(): Agent {
  return {
    id: "agent-1",
    gitRepositories: [
      {
        id: "r1",
        name: "donger",
        provider: "gitee",
        url: `https://gitee.com/${REPO_PATH}.git`,
        required: true,
        shallow: true,
        syncMode: "fastForward",
        credentialCode: "gitee-pat",
      },
    ],
  } as unknown as Agent;
}

const PROPOSAL_BODY =
  '修复说明\n\n```donger-proposal\n{"v":1,"feedbackId":"fb-1","kind":"bugfix","testEvidence":"npm test 绿"}\n```';

/** 缺省绿路 MR：干净 diff、提案齐全、master 未漂移 */
function greenMr() {
  return {
    listMr: [{ number: 7, title: "[autofix] fb-1 修复导出字段", head: { ref: "fix-20261017-x", sha: "0123456789abcdef0123456789abcdef01234567" }, base: { ref: "master", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }],
    getMr: {
      number: 7,
      title: "[autofix] fb-1 修复导出字段",
      body: PROPOSAL_BODY,
      head: { ref: "fix-20261017-x", sha: "0123456789abcdef0123456789abcdef01234567" },
      base: { ref: "master", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      html_url: "https://gitee.com/owner/donger/pulls/7",
    },
    getMrDiff: [{ old_path: "src/adapters/web-channel.ts", new_path: "src/adapters/web-channel.ts", patch: "--- a\n+++ b\n@@\n+a\n+b\n-c" }],
    getBranch: { commit: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  };
}

interface Harness {
  svc: ReleaseService;
  runs: Map<string, ReleaseRun>;
  merged: string[];
  feedbacks: Map<string, Feedback>;
  notifications: Array<{ event: string; userId: string; title: string }>;
  rateLimited: boolean;
  api: GitPlatformApi;
  listMrPayload: Array<Record<string, unknown>>;
  disabled: { value: boolean };
}

function makeHarness(mr = greenMr()): Harness {
  const runs = new Map<string, ReleaseRun>();
  const feedbacks = new Map<string, Feedback>([
    [
      "fb-1",
      {
        id: "fb-1",
        userId: "user-9",
        category: "logic",
        content: "导出缺字段",
        images: [],
        conversationIds: [],
        status: "open",
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      },
    ],
  ]);
  const notifications: Harness["notifications"] = [];
  const merged: string[] = [];
  const state = { value: false };
  const h: Harness = {
    runs,
    merged,
    feedbacks,
    notifications,
    rateLimited: false,
    listMrPayload: mr.listMr,
    disabled: state,
    api: {
      provider: "gitee",
      listMr: async () => okJson(h.listMrPayload),
      getMr: async () => okJson(mr.getMr),
      getMrDiff: async () => okJson(mr.getMrDiff),
      getBranch: async () => okJson(mr.getBranch),
      mergeMr: async (input) => {
        merged.push(input.number);
        return okJson({ ok: true });
      },
      createRepo: async () => okJson({}),
      createBranch: async () => okJson({}),
      createMr: async () => okJson({}),
      listBranches: async () => okJson([]),
      latestPipeline: async () => ({ ok: false, status: 0, body: "不支持" }),
      getFileRaw: async () => okJson(""),
    },
    svc: undefined as unknown as ReleaseService,
  };
  const workflowStore = {
    listAll: async () => [makeWorkflow()],
    get: async () => makeWorkflow(),
  } as unknown as WorkflowStore;
  const agentStore = {
    get: async (): Promise<Agent | undefined> => makeAgent(),
  } as unknown as AgentStore;
  const credentialSets = {
    getFilledValues: async (): Promise<Array<{ code: string; values: Record<string, string> }>> => [
      { code: "gitee-pat", values: { access_token: "tok" } },
    ],
  } as unknown as CredentialSetStore;
  const releaseRunStore = {
    insert: async (run: ReleaseRun) => {
      runs.set(run.id, run);
    },
    getByMr: async (rp: string, n: string): Promise<ReleaseRun | undefined> =>
      [...runs.values()].find((r) => r.repositoryPath === rp && r.mrNumber === n),
    getByHeadSha: async (rp: string, sha: string): Promise<ReleaseRun | undefined> =>
      [...runs.values()].find(
        (r) => r.repositoryPath === rp && r.headSha.toLowerCase() === sha.toLowerCase(),
      ),
    listByWorkflow: async (wfId: string, limit = 50): Promise<ReleaseRun[]> =>
      [...runs.values()].filter((r) => r.workflowId === wfId).slice(0, limit),
    listAll: async (limit = 200): Promise<ReleaseRun[]> => [...runs.values()].slice(0, limit),
    updateStatus: async (
      id: string,
      status: ReleaseRun["status"],
      patch?: { detail?: string; policyVerdict?: string },
    ) => {
      const run = runs.get(id);
      if (run) {
        run.status = status;
        if (patch?.detail !== undefined) run.detail = patch.detail;
        run.updatedAt = "2026-10-17T01:00:00.000Z";
      }
    },
  } as unknown as ReleaseRunStore;
  const feedbackStore = {
    get: async (id: string): Promise<Feedback | undefined> => feedbacks.get(id),
    updateStatus: async (id: string, status: FeedbackStatus) => {
      const fb = feedbacks.get(id);
      if (fb) fb.status = status;
    },
  } as unknown as FeedbackStore;
  const rateLimiter = {
    hit: () => !h.rateLimited,
    count: () => 0,
  } as unknown as RateLimiter;
  const platformApis: GitPlatformApiResolver = () => h.api;
  h.svc = new ReleaseService({
    workflowStore,
    agentStore,
    credentialSets,
    releaseRunStore,
    feedbackStore,
    notifications: {
      notify: async (intent: { event: string; recipients: Array<{ userId: string }>; title: string }) => {
        for (const r of intent.recipients) {
          notifications.push({ event: intent.event, userId: r.userId, title: intent.title });
        }
      },
    } as never,
    rateLimiter,
    logger: { info() {}, warn() {}, error() {} } as never,
    platformApis,
    disabled: () => state.value,
    now: () => new Date("2026-10-17T00:30:00.000Z"),
  });
  return h;
}

describe("ReleaseService.tick 自动合并绿路", () => {
  it("命中策略 → 平台 API 合并 → release_run=merged → 反馈 open→accepted → 双通知", async () => {
    const h = makeHarness();
    const outcomes = await h.svc.tick();
    expect(h.merged).toEqual(["7"]);
    const run = [...h.runs.values()][0];
    expect(run?.status).toBe("merged");
    expect(run?.feedbackId).toBe("fb-1");
    expect(h.feedbacks.get("fb-1")?.status).toBe("accepted");
    const events = h.notifications.map((n) => `${n.event}:${n.userId}`);
    expect(events).toContain("deploy.detected:admin-1");
    expect(events).toContain("deploy.detected:user-9");
    expect(outcomes[0]?.processed[0]?.action).toBe("merged");
  });

  it("同一 MR 终身一行：二次 tick 去重跳过", async () => {
    const h = makeHarness();
    await h.svc.tick();
    const count = h.runs.size;
    await h.svc.tick();
    expect(h.runs.size).toBe(count);
    expect(h.merged).toEqual(["7"]);
  });
});

describe("ReleaseService.tick 策略拒绝", () => {
  it("触碰红线路径 → needs_human，不合并，通知管理员", async () => {
    const mr = greenMr();
    mr.getMrDiff = [
      {
        old_path: "src/orchestrator/default-gates.ts",
        new_path: "src/orchestrator/default-gates.ts",
        patch: "--- a\n+++ b\n@@\n+a",
      },
    ];
    const h = makeHarness(mr);
    await h.svc.tick();
    expect(h.merged).toEqual([]);
    const run = [...h.runs.values()][0];
    expect(run?.status).toBe("needs_human");
    const verdict = JSON.parse(run?.policyVerdict ?? "{}");
    expect(verdict.reasons[0]).toContain("触碰红线路径");
    expect(h.notifications.some((n) => n.event === "deploy.failed" && n.userId === "admin-1")).toBe(true);
  });

  it("提案块缺失 → needs_human（提案协议是准入条件）", async () => {
    const mr = greenMr();
    (mr.getMr as Record<string, unknown>).body = "普通描述，无提案块";
    const h = makeHarness(mr);
    await h.svc.tick();
    const run = [...h.runs.values()][0];
    expect(run?.status).toBe("needs_human");
    expect(run?.policyVerdict).toContain("提案块");
  });

  it("master 已前进 → needs_human", async () => {
    const mr = greenMr();
    mr.getBranch = { commit: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } };
    const h = makeHarness(mr);
    await h.svc.tick();
    const run = [...h.runs.values()][0];
    expect(run?.status).toBe("needs_human");
    expect(JSON.parse(run?.policyVerdict ?? "{}").reasons.join()).toContain("master 已前进");
  });

  it("每日配额满 → 不落终态行，仅告警通知（去重键按日）", async () => {
    const h = makeHarness();
    h.rateLimited = true;
    await h.svc.tick();
    expect(h.runs.size).toBe(0);
    expect(h.merged).toEqual([]);
    expect(h.notifications.filter((n) => n.userId === "admin-1")).toHaveLength(1);
  });
});

describe("ReleaseService 冷却与开关", () => {
  it("最近一条 rolled_back 在冷却期内 → tick 跳过", async () => {
    const h = makeHarness();
    h.runs.set("r0", {
      id: "r0",
      workflowId: "wf-1",
      workflowRunId: null,
      feedbackId: null,
      repositoryPath: REPO_PATH,
      mrNumber: "1",
      mrUrl: "",
      sourceBranch: "fix-20261016-old",
      headSha: "1111111111111111111111111111111111111111",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyVerdict: "{}",
      status: "rolled_back",
      detail: null,
      createdAt: "2026-10-16T23:00:00.000Z",
      updatedAt: "2026-10-16T23:00:00.000Z",
    });
    const outcome = (await h.svc.tick())[0];
    expect(outcome?.skipped).toContain("冷却");
  });

  it("kill-switch 开启 → tick 空转", async () => {
    const h = makeHarness();
    h.disabled.value = true;
    expect(await h.svc.tick()).toEqual([]);
    expect(h.merged).toEqual([]);
  });
});

describe("ReleaseService.handleReleaseResult 回报闭环", () => {
  async function seedMerged(h: Harness) {
    await h.svc.tick();
    const run = [...h.runs.values()][0];
    return run;
  }

  it("deployed → 状态推进 + 反馈 resolved + 成功通知（含提交人）", async () => {
    const h = makeHarness();
    const run = await seedMerged(h);
    const res = await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: run?.headSha,
      status: "deployed",
      imageTag: "donger:auto-0123456",
    });
    expect(res.ok).toBe(true);
    expect(h.feedbacks.get("fb-1")?.status).toBe("resolved");
    expect(h.notifications.some((n) => n.event === "deploy.succeeded" && n.userId === "user-9")).toBe(true);
  });

  it("rolled_back → 反馈回 accepted + 失败通知管理员", async () => {
    const h = makeHarness();
    const run = await seedMerged(h);
    const res = await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: run?.headSha,
      status: "rolled_back",
      reason: "健康检查超时",
    });
    expect(res.ok).toBe(true);
    expect(h.feedbacks.get("fb-1")?.status).toBe("accepted");
    expect(h.notifications.some((n) => n.event === "deploy.failed")).toBe(true);
  });

  it("build_failed → 维持 merged（生产未触碰）", async () => {
    const h = makeHarness();
    const run = await seedMerged(h);
    await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: run?.headSha,
      status: "build_failed",
      reason: "docker build 失败",
    });
    const after = [...h.runs.values()][0];
    expect(after?.status).toBe("merged");
    expect(after?.detail).toContain("build 失败");
    expect(h.feedbacks.get("fb-1")?.status).toBe("accepted"); // 合并时的推进保持
  });

  it("headSha 未命中 → 404 语义；payload 非法 → 400；重复回报幂等", async () => {
    const h = makeHarness();
    const miss = await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: "9999999999999999999999999999999999999999",
      status: "deployed",
    });
    expect(miss.ok).toBe(false);
    expect(miss.status).toBe(404);
    const bad = await h.svc.handleReleaseResult({ repositoryPath: REPO_PATH });
    expect(bad.status).toBe(400);

    const run = await seedMerged(h);
    await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: run?.headSha,
      status: "deployed",
    });
    const again = await h.svc.handleReleaseResult({
      repositoryPath: REPO_PATH,
      headSha: run?.headSha,
      status: "deployed",
    });
    expect(again.ok).toBe(true);
  });
});

describe("extractMrFacts 平台字段分流", () => {
  it("gitee/github 形态（head/base sha）与 jihulab 形态（diff_refs）", async () => {
    const { extractMrFacts } = await import("../../src/orchestrator/release-service.js");
    const gitee = extractMrFacts("gitee", {
      number: 7,
      title: "[autofix] x",
      body: "b",
      head: { ref: "fix-1", sha: "0123456789abcdef0123456789abcdef01234567" },
      base: { ref: "master", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      html_url: "u",
    });
    expect(gitee).toMatchObject({ number: "7", sourceBranch: "fix-1", targetBranch: "master" });
    const gitlab = extractMrFacts("jihulab", {
      iid: 9,
      description: "d",
      source_branch: "fix-2",
      target_branch: "master",
      diff_refs: {
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        base_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      web_url: "w",
    });
    expect(gitlab).toMatchObject({ number: "9", headSha: "0123456789abcdef0123456789abcdef01234567" });
  });
});
