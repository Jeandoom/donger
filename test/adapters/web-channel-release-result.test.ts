import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtSessionStore } from "../../src/adapters/jwt-session-store.js";
import { MemoryRateLimiter } from "../../src/adapters/memory-rate-limiter.js";
import { SqliteAgentStore } from "../../src/adapters/sqlite-agent-store.js";
import { SqliteConversationStore } from "../../src/adapters/sqlite-conversation-store.js";
import { SqliteFeedbackStore } from "../../src/adapters/sqlite-feedback-store.js";
import { SqliteReleaseRunStore } from "../../src/adapters/sqlite-release-run-store.js";
import { SqliteUserStore } from "../../src/adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "../../src/adapters/sqlite-workflow-store.js";
import { WebChannel } from "../../src/adapters/web-channel.js";
import { ReleaseService } from "../../src/orchestrator/release-service.js";
import { createSecretCipher } from "../../src/util/secret-cipher.js";

/**
 * L2 宿主管线回报端点 e2e（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.7）：
 * POST /api/internal/release-result 全链——Bearer 鉴权（未配置=404 不暴露存在性）、
 * 真 ReleaseService + 真 sqlite 存储（release_runs/feedbacks）状态推进与幂等。
 */

const REPO_PATH = "owner/donger";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "hook-tok-123";

let web: WebChannel;
let db: Database.Database;
let tmpDir: string;
let releaseRunStore: SqliteReleaseRunStore;
let feedbackStore: SqliteFeedbackStore;
let service: ReleaseService;
const realFetch = globalThis.fetch;

async function startChannel(opts: { token?: string } = {}): Promise<number> {
  db = new Database(":memory:");
  tmpDir = mkdtempSync(join(tmpdir(), "release-hook-"));
  const sessionStore = new JwtSessionStore(db, "rel-secret");
  sessionStore.migrate();
  const userStore = new SqliteUserStore(db, { adminExternalIds: new Set(), usersDir: tmpDir });
  userStore.migrate();
  userStore.migrateCredentials();
  feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  releaseRunStore = new SqliteReleaseRunStore(db);
  releaseRunStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const agentStore = new SqliteAgentStore(db, createSecretCipher("pw"));
  agentStore.migrate();
  const convStore = new SqliteConversationStore(db);
  convStore.migrate();
  const notifications: Array<{ event: string; userId: string }> = [];
  service = new ReleaseService({
    workflowStore,
    agentStore,
    releaseRunStore,
    feedbackStore,
    notifications: {
      notify: async (intent: {
        event: string;
        recipients: Array<{ userId: string }>;
        title: string;
      }) => {
        for (const r of intent.recipients) notifications.push({ event: intent.event, userId: r.userId });
      },
    } as never,
    rateLimiter: new MemoryRateLimiter(),
    logger: { info() {}, warn() {}, error() {} } as never,
    platformApis: () => undefined, // 无 MR 轮询场景；回报链路不触网
  });
  web = new WebChannel({
    port: 0,
    host: "127.0.0.1",
    workspaceDir: tmpDir,
    sessionStore,
    userStore,
    feedbackStore,
    agentStore,
    conversationStore: convStore,
    workflowStore,
    releaseResultHandler: service,
    ...(opts.token !== undefined ? { releaseHookToken: opts.token } : {}),
  });
  web.onMessage(() => {});
  await web.ready();
  if (!web.boundPort) throw new Error("server not listening");
  return web.boundPort;
}

async function seedMergedRun(): Promise<void> {
  await feedbackStore.create({
    id: "fb-e2e",
    userId: "user-submit",
    category: "logic",
    content: "导出缺字段（e2e）",
    images: [],
    conversationIds: [],
    status: "accepted",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  });
  await releaseRunStore.insert({
    id: "run-e2e",
    workflowId: "wf-x",
    workflowRunId: null,
    feedbackId: "fb-e2e",
    repositoryPath: REPO_PATH,
    mrNumber: "7",
    mrUrl: "https://gitee.com/owner/donger/pulls/7",
    sourceBranch: "fix-20261017-e2e",
    headSha: HEAD,
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policyVerdict: '{"allow":true,"reasons":[],"warnings":[]}',
    status: "merged",
    detail: null,
    createdAt: "2026-10-17T00:10:00.000Z",
    updatedAt: "2026-10-17T00:10:00.000Z",
  });
}

function post(port: number, path: string, body: string, auth?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body,
  });
}

describe("POST /api/internal/release-result", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await web.stop();
    db.close();
  });

  it("token 未配置 → 404（不暴露存在性）", async () => {
    const port = await startChannel();
    const payload = JSON.stringify({ repositoryPath: REPO_PATH, headSha: HEAD, status: "deployed" });
    expect((await post(port, "/api/internal/release-result", payload, `Bearer ${TOKEN}`)).status).toBe(404);
  });

  it("绿路：正确 token + merged run → deployed → 200 + 反馈 resolved + run 状态推进", async () => {
    const port = await startChannel({ token: TOKEN });
    await seedMergedRun();
    const res = await post(
      port,
      "/api/internal/release-result",
      JSON.stringify({ repositoryPath: REPO_PATH, headSha: HEAD, status: "deployed", imageTag: "donger:auto-0123456" }),
      `Bearer ${TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deployed" });
    const run = await releaseRunStore.getByMr(REPO_PATH, "7");
    expect(run?.status).toBe("deployed");
    const fb = await feedbackStore.get("fb-e2e");
    expect(fb?.status).toBe("resolved");
  });

  it("rolled_back → 反馈回 accepted；headSha 未命中 → 404；重复回报幂等 200", async () => {
    const port = await startChannel({ token: TOKEN });
    await seedMergedRun();
    const miss = await post(
      port,
      "/api/internal/release-result",
      JSON.stringify({ repositoryPath: REPO_PATH, headSha: "9999999999999999999999999999999999999999", status: "deployed" }),
      `Bearer ${TOKEN}`,
    );
    expect(miss.status).toBe(404);

    const rb = await post(
      port,
      "/api/internal/release-result",
      JSON.stringify({ repositoryPath: REPO_PATH, headSha: HEAD, status: "rolled_back", reason: "健康检查超时" }),
      `Bearer ${TOKEN}`,
    );
    expect(rb.status).toBe(200);
    expect((await feedbackStore.get("fb-e2e"))?.status).toBe("accepted");

    const again = await post(
      port,
      "/api/internal/release-result",
      JSON.stringify({ repositoryPath: REPO_PATH, headSha: HEAD, status: "rolled_back" }),
      `Bearer ${TOKEN}`,
    );
    expect(again.status).toBe(200);
  });

  it("非 JSON body → 400；GET 方法不进该分支（守卫面 404）", async () => {
    const port = await startChannel({ token: TOKEN });
    const bad = await post(port, "/api/internal/release-result", "not-json", `Bearer ${TOKEN}`);
    expect(bad.status).toBe(400);
    const get = await fetch(`http://127.0.0.1:${port}/api/internal/release-result`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
  });
});
