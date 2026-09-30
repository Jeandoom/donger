import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDeployStore } from "../../src/adapters/sqlite-deploy-store.js";
import { DeployTargetInputSchema } from "../../src/domain/deploy.js";

function makeDb() {
  const db = new Database(":memory:");
  const store = new SqliteDeployStore(db);
  store.migrate();
  return { db, store };
}

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "测试服务",
    service: "demo-svc",
    provider: "jihulab",
    repoUrl: "https://jihulab.com/group/demo.git",
    branch: "master",
    gitCredentialCode: "jihulab-pat",
    ssh: { host: "192.168.1.10", port: 22, username: "deploy", credentialCode: "ssh-deploy" },
    workdir: "/srv/demo",
    prepareCommands: ["cd {workdir} && git pull origin {branch}"],
    restartCommands: ["systemctl restart {service}"],
    healthCheck: { cmd: "curl -sf http://127.0.0.1:3000/health", expectContains: "ok" },
    autoDeploy: true,
    enabled: true,
    ...overrides,
  };
}

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("SqliteDeployStore", () => {
  it("createTarget 填默认值并可读回", async () => {
    const { db, store } = makeDb();
    dbs.push(db);
    const input = targetInput();
    delete (input as Record<string, unknown>).restartCommands;
    const t = await store.createTarget(DeployTargetInputSchema.parse(input), "u1");
    expect(t.id).toBeTruthy();
    expect(t.ownerId).toBe("u1");
    const read = await store.getTarget(t.id);
    expect(read?.restartCommands).toEqual([]); // zod default
    expect(read?.autoDeploy).toBe(true);
  });

  it("字段安全 regex 拒绝元字符（workdir/命令多行/branch）", () => {
    expect(() =>
      DeployTargetInputSchema.parse(targetInput({ workdir: "/srv/a;rm -rf /" })),
    ).toThrow();
    expect(() =>
      DeployTargetInputSchema.parse(
        targetInput({ prepareCommands: ["cd /x && git pull\nrm -rf /"] }),
      ),
    ).toThrow();
    expect(() => DeployTargetInputSchema.parse(targetInput({ branch: "a b" }))).toThrow();
    expect(() =>
      DeployTargetInputSchema.parse(targetInput({ repoUrl: "http://x/y.git" })),
    ).toThrow();
  });

  it("listEnabledTargets 过滤 enabled", async () => {
    const { db, store } = makeDb();
    dbs.push(db);
    const a = await store.createTarget(DeployTargetInputSchema.parse(targetInput()), "u1");
    await store.createTarget(
      DeployTargetInputSchema.parse(targetInput({ name: "b", service: "b-svc", enabled: false })),
      "u1",
    );
    const enabled = await store.listEnabledTargets();
    expect(enabled.map((t) => t.id)).toEqual([a.id]);
  });

  it("部署单状态机 + lastSuccess 单一真源 + 崩溃清扫", async () => {
    const { db, store } = makeDb();
    dbs.push(db);
    const t = await store.createTarget(DeployTargetInputSchema.parse(targetInput()), "u1");
    await store.createOrder({
      id: "o1",
      targetId: t.id,
      trigger: "poll",
      ref: "abc1234def",
      sha: "abc1234def",
      status: "running",
      steps: [],
      startedAt: new Date().toISOString(),
    });
    expect((await store.getOrder("o1"))?.status).toBe("running");
    // running 不算 lastSuccess
    expect(await store.getLastSuccessOrder(t.id)).toBeUndefined();
    await store.updateOrder("o1", {
      status: "failed",
      error: "x",
      finishedAt: new Date().toISOString(),
    });
    await store.createOrder({
      id: "o2",
      targetId: t.id,
      trigger: "manual",
      sha: "fff0000aaa",
      status: "success",
      steps: [{ name: "prepare[1]", command: "cd", exitCode: 0, durationMs: 3 }],
      startedAt: new Date().toISOString(),
    });
    const last = await store.getLastSuccessOrder(t.id);
    expect(last?.id).toBe("o2");
    expect(last?.sha).toBe("fff0000aaa");
    expect((await store.listOrders(t.id)).map((o) => o.id)).toEqual(["o2", "o1"]);
    // 崩溃清扫：running → failed
    await store.createOrder({
      id: "o3",
      targetId: t.id,
      trigger: "agent",
      status: "running",
      steps: [],
      startedAt: new Date().toISOString(),
    });
    expect(await store.failRunningOrders("process restart")).toBe(1);
    expect((await store.getOrder("o3"))?.status).toBe("failed");
  });

  it("updateTarget 全量替换并保留 id/owner/createdAt", async () => {
    const { db, store } = makeDb();
    dbs.push(db);
    const t = await store.createTarget(DeployTargetInputSchema.parse(targetInput()), "u1");
    const updated = await store.updateTarget(
      t.id,
      DeployTargetInputSchema.parse(targetInput({ name: "改名" })),
    );
    expect(updated.name).toBe("改名");
    expect(updated.id).toBe(t.id);
    expect(updated.createdAt).toBe(t.createdAt);
  });
});
