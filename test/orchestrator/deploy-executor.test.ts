import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDeployStore } from "../../src/adapters/sqlite-deploy-store.js";
import { type DeployTarget, DeployTargetInputSchema } from "../../src/domain/deploy.js";
import { DeployExecutor } from "../../src/orchestrator/deploy-executor.js";
import type { NotificationService } from "../../src/orchestrator/notification-service.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { Logger } from "../../src/util/logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const credStore: CredentialSetStore = {
  getFilledValues: async (_uid, codes) =>
    codes.map((code) => ({ code, values: code === "ssh-cred" ? { private_key: "K" } : {} })),
} as unknown as CredentialSetStore;

function makeStore() {
  const db = new Database(":memory:");
  const store = new SqliteDeployStore(db);
  store.migrate();
  return { db, store };
}

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

async function seed(
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
      ssh: { host: "h", port: 22, username: "u", credentialCode: "ssh-cred" },
      workdir: "/srv/svc",
      prepareCommands: ["cd {workdir} && git pull origin {branch}"],
      ...overrides,
    }),
    "u1",
  );
}

describe("DeployExecutor", () => {
  it("成功路径：模板渲染正确 + 状态 success + sha 落库", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store);
    const commands: string[] = [];
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      sshRunner: async (_e, _a, cmd) => {
        commands.push(cmd);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const order = await executor.run(t, { trigger: "manual", ref: "abcd1234ef56" });
    expect(order.status).toBe("success");
    expect(commands).toEqual(["cd /srv/svc && git pull origin master"]);
    expect((await store.getLastSuccessOrder(t.id))?.sha).toBe("abcd1234ef56");
  });

  it("ref 缺省回退分支名（非 sha 不落 sha 字段）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store);
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      sshRunner: async (_e, _a, cmd) => ({ exitCode: 0, stdout: "x", stderr: "" }),
    });
    const order = await executor.run(t, { trigger: "manual" });
    expect(order.ref).toBe("master");
    expect(order.sha).toBeUndefined();
    const last = await store.getLastSuccessOrder(t.id);
    expect(last?.sha).toBeUndefined(); // sha 空 → 下轮轮询会视为「有变化」再部署（符合语义）
  });

  it("prepare 失败：status=failed + 步骤退出码记录 + deploy.failed 通知", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store);
    const notify = vi.fn();
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      notifications: { notify } as unknown as NotificationService,
      sshRunner: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
    });
    const order = await executor.run(t, { trigger: "poll", ref: "111122223333" });
    expect(order.status).toBe("failed");
    expect(order.steps[0]?.exitCode).toBe(2);
    expect(order.error).toContain("退出码 2");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "deploy.failed" }));
  });

  it("健康检查 expectContains 不匹配 → failed", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, {
      healthCheck: { cmd: "curl -sf http://127.0.0.1/health", expectContains: '"ok":true' },
    });
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      sshRunner: async () => ({ exitCode: 0, stdout: '{"ok":false}', stderr: "" }),
    });
    const order = await executor.run(t, { trigger: "manual" });
    expect(order.status).toBe("failed");
    expect(order.error).toContain("健康检查未通过");
  });

  it("SSH 凭证缺失（private_key/password 均无）→ failed 且不执行命令", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store);
    const ran: string[] = [];
    const emptyCred: CredentialSetStore = {
      getFilledValues: async (_uid, codes) => codes.map((code) => ({ code, values: {} })),
    } as unknown as CredentialSetStore;
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: emptyCred,
      logger,
      sshRunner: async (_e, _a, cmd) => {
        ran.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const order = await executor.run(t, { trigger: "manual" });
    expect(order.status).toBe("failed");
    expect(order.error).toContain("SSH 凭证未填写");
    expect(ran).toEqual([]);
  });

  it("同 target 互斥：并发调用串行执行", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store);
    let active = 0;
    let maxActive = 0;
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      sshRunner: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await Promise.all([
      executor.run(t, { trigger: "manual" }),
      executor.run(t, { trigger: "manual" }),
    ]);
    expect(maxActive).toBe(1);
    expect((await store.listOrders(t.id)).length).toBe(2);
  });

  it("runRestart：逐条执行；未配置 restartCommands 报错", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, { restartCommands: ["systemctl restart {service}"] });
    const executor = new DeployExecutor({
      deployStore: store,
      credentialSets: credStore,
      logger,
      sshRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const steps = await executor.runRestart(t);
    expect(steps[0]?.command).toBe("systemctl restart svc");
    const t2 = await seed(store, { name: "b", service: "b" });
    await expect(executor.runRestart(t2)).rejects.toThrow("不支持重启动作");
  });
});
