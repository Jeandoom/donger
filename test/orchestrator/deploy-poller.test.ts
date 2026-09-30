import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDeployStore } from "../../src/adapters/sqlite-deploy-store.js";
import { type DeployTarget, DeployTargetInputSchema } from "../../src/domain/deploy.js";
import { DeployExecutor } from "../../src/orchestrator/deploy-executor.js";
import { DeployPoller } from "../../src/orchestrator/deploy-poller.js";
import type { NotificationService } from "../../src/orchestrator/notification-service.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { GitPlatformApi } from "../../src/ports/git-platform-api.js";
import type { SshCommandRunner } from "../../src/ports/ssh-command-runner.js";
import type { Logger } from "../../src/util/logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function credentialStub(values?: Record<string, string>): CredentialSetStore {
  return {
    getFilledValues: async (_uid, codes) =>
      codes.map((code) => ({
        code,
        values:
          values ?? (code === "jihulab-pat" ? { access_token: "tok" } : { private_key: "KEY" }),
      })),
  } as unknown as CredentialSetStore;
}

const SSH_OK: SshCommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });

function makeStore() {
  const db = new Database(":memory:");
  const store = new SqliteDeployStore(db);
  store.migrate();
  return { db, store };
}

async function seedTarget(
  store: SqliteDeployStore,
  overrides: Record<string, unknown> = {},
): Promise<DeployTarget> {
  return store.createTarget(
    DeployTargetInputSchema.parse({
      name: "svc",
      service: "svc",
      provider: "jihulab",
      repoUrl: "https://jihulab.com/group/demo.git",
      branch: "master",
      gitCredentialCode: "jihulab-pat",
      ssh: { host: "h1", port: 22, username: "u", credentialCode: "ssh-cred" },
      workdir: "/srv/svc",
      prepareCommands: ["cd {workdir} && git pull"],
      autoDeploy: true,
      enabled: true,
      ...overrides,
    }),
    "u1",
  );
}

function gitlabApi(body: string, ok = true, status = 200): GitPlatformApi {
  return { getBranch: async () => ({ ok, status, body }) } as unknown as GitPlatformApi;
}

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("DeployPoller", () => {
  it("无变化：不部署不通知", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seedTarget(store);
    await store.createOrder({
      id: "o1",
      targetId: t.id,
      trigger: "poll",
      sha: "aaaa00001111",
      status: "success",
      steps: [],
      startedAt: new Date().toISOString(),
    });
    const run = vi.fn();
    const notify = vi.fn();
    const poller = new DeployPoller({
      deployStore: store,
      credentialSets: credentialStub(),
      platformApis: () => gitlabApi(JSON.stringify({ commit: { id: "aaaa00001111" } })),
      executor: { run } as unknown as DeployExecutor,
      notifications: { notify } as unknown as NotificationService,
      logger,
    });
    await poller.pollTarget(t);
    expect(run).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("有变化 + autoDeploy：零 LLM 直接执行（trigger=poll）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seedTarget(store);
    const run = vi.fn();
    const poller = new DeployPoller({
      deployStore: store,
      credentialSets: credentialStub(),
      platformApis: () => gitlabApi(JSON.stringify({ commit: { id: "bbbb00002222" } })),
      executor: { run } as unknown as DeployExecutor,
      notifications: { notify: vi.fn() } as unknown as NotificationService,
      logger,
    });
    await poller.pollTarget(t);
    expect(run).toHaveBeenCalledWith(t, { trigger: "poll", ref: "bbbb00002222" });
  });

  it("有变化 + 非 autoDeploy：仅站内信（dedupeKey 含 sha）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seedTarget(store, { autoDeploy: false });
    const run = vi.fn();
    const notify = vi.fn();
    const poller = new DeployPoller({
      deployStore: store,
      credentialSets: credentialStub(),
      platformApis: () => gitlabApi(JSON.stringify({ commit: { id: "cccc00003333" } })),
      executor: { run } as unknown as DeployExecutor,
      notifications: { notify } as unknown as NotificationService,
      logger,
    });
    await poller.pollTarget(t);
    expect(run).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    const intent = notify.mock.calls[0]?.[0] as { event: string; dedupeKey: string };
    expect(intent.event).toBe("deploy.detected");
    expect(intent.dedupeKey).toBe(`deploy.detected:${t.id}:cccc00003333`);
  });

  it("sha 提取：gitee/github=commit.sha、gitlab=commit.id、坏 body 跳过", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const giteeTarget = await seedTarget(store, {
      name: "g",
      service: "g",
      provider: "gitee",
      repoUrl: "https://gitee.com/o/r.git",
    });
    const run = vi.fn();
    const mk = (provider: string, body: string) =>
      new DeployPoller({
        deployStore: store,
        credentialSets: credentialStub(),
        platformApis: () => gitlabApi(body),
        executor: { run } as unknown as DeployExecutor,
        notifications: { notify: vi.fn() } as unknown as NotificationService,
        logger,
      });
    await mk("gitee", JSON.stringify({ commit: { sha: "dddd00004444" } })).pollTarget(giteeTarget);
    expect(run).toHaveBeenCalledWith(expect.anything(), { trigger: "poll", ref: "dddd00004444" });
    run.mockClear();
    await mk("jihulab", "not-json").pollTarget(giteeTarget);
    expect(run).not.toHaveBeenCalled();
  });

  it("git 凭证缺失：跳过不炸", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seedTarget(store);
    const poller = new DeployPoller({
      deployStore: store,
      credentialSets: credentialStub({}), // 空 values → PAT 缺失
      platformApis: () => gitlabApi(JSON.stringify({ commit: { id: "eeee00005555" } })),
      executor: { run: vi.fn() } as unknown as DeployExecutor,
      logger,
    });
    await expect(poller.pollTarget(t)).resolves.toBeUndefined();
  });

  it("pollOnce：单目标失败不阻塞其余目标", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    await seedTarget(store, {
      name: "bad",
      service: "bad",
      repoUrl: "https://gitee.com/o/bad.git",
    });
    const good = await seedTarget(store, { name: "good", service: "good" });
    let call = 0;
    const poller = new DeployPoller({
      deployStore: store,
      credentialSets: credentialStub(),
      // 第一次调用（bad，顺序不确定）抛错，其余正常返回新 sha
      platformApis: () =>
        ({
          getBranch: async () => {
            call += 1;
            if (call === 1) throw new Error("boom");
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ commit: { id: "ffff00006666" } }),
            };
          },
        }) as unknown as GitPlatformApi,
      executor: { run: vi.fn() } as unknown as DeployExecutor,
      logger,
    });
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(call).toBe(2);
    expect(good.id).toBeTruthy();
  });
});

describe("DeployExecutor（poller 邻接集成）", () => {
  it("成功部署写回 lastSuccessSha（供下轮 diff）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seedTarget(store);
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credentialStub(),
      sshRunner: SSH_OK,
      logger,
    });
    const order = await executor.run(t, { trigger: "poll", ref: "1234abcd5678" });
    expect(order.status).toBe("success");
    const last = await store.getLastSuccessOrder(t.id);
    expect(last?.sha).toBe("1234abcd5678");
  });
});
