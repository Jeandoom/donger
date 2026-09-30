import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteDeployStore } from "../../src/adapters/sqlite-deploy-store.js";
import { DeployTargetInputSchema } from "../../src/domain/deploy.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
import { DeployExecutor } from "../../src/orchestrator/deploy-executor.js";
import { canViewerUseHostTools, hostToolDefinitions } from "../../src/orchestrator/host-tools.js";
import type { CredentialSetStore } from "../../src/ports/credential-set-store.js";
import type { SshCommandRunner } from "../../src/ports/ssh-command-runner.js";
import type { Logger } from "../../src/util/logger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;
const credStore: CredentialSetStore = {
  getFilledValues: async (_uid, codes) =>
    codes.map((code) => ({ code, values: { private_key: "K" } })),
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

async function seed(store: SqliteDeployStore, ownerId: string, enabled = true) {
  return store.createTarget(
    DeployTargetInputSchema.parse({
      name: "svc",
      service: "svc",
      provider: "gitee",
      repoUrl: "https://gitee.com/o/r.git",
      branch: "master",
      ssh: { host: "h", port: 22, username: "u", credentialCode: "ssh-cred" },
      workdir: "/srv/svc",
      prepareCommands: ["cd {workdir} && git pull"],
      enabled,
    }),
    ownerId,
  );
}

function tools(
  store: SqliteDeployStore,
  viewer: { id: string; role: "admin" | "user" },
  sshRunner?: SshCommandRunner,
) {
  const runner =
    sshRunner ?? ((async () => ({ exitCode: 0, stdout: "out", stderr: "" })) as SshCommandRunner);
  const executor = new DeployExecutor({
    deployStore: store,
    credentialSets: credStore,
    logger,
    sshRunner: runner,
  });
  const defs = hostToolDefinitions({
    viewer,
    deployStore: store,
    executor,
    sshRunner: runner,
    credentialSets: credStore,
  });
  const byName = (n: string) => {
    const t = defs.find((d) => d.name === n);
    if (!t) throw new Error(`tool not found: ${n}`);
    return t;
  };
  return { defs, byName };
}

describe("canViewerUseHostTools（挂载判定）", () => {
  it("admin 恒可挂载；target 属主可；他人/无目标不可", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    await seed(store, "u1");
    expect(await canViewerUseHostTools(store, { id: "admin1", role: "admin" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u1", role: "user" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u2", role: "user" })).toBe(false);
  });
  it("属主但全部 disabled → 不可挂载", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    await seed(store, "u1", false);
    expect(await canViewerUseHostTools(store, { id: "u1", role: "user" })).toBe(false);
    expect(await canViewerUseHostTools(store, { id: "u1", role: "admin" })).toBe(true);
  });
});

describe("donger-host 工具集（目标登记制）", () => {
  it("非属主非 admin 访问他人 target → isError（防横向移动）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, "u1");
    const { byName } = tools(store, { id: "u2", role: "user" });
    const r = await byName("host_status").handler({ targetId: t.id });
    expect(r.isError).toBe(true);
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toContain("无权访问");
  });

  it("目标不存在 → isError（存在性不泄漏）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const { byName } = tools(store, { id: "u1", role: "user" });
    const r = await byName("host_status").handler({ targetId: "nope" });
    expect(r.isError).toBe(true);
  });

  it("host_logs_tail：固定命令模板 + 元字符 file 拒绝", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, "u1");
    const commands: string[] = [];
    const { byName } = tools(store, { id: "u1", role: "user" }, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "log line", stderr: "" };
    });
    const r = await byName("host_logs_tail").handler({
      targetId: t.id,
      file: "/var/log/app.log",
      lines: 50,
    });
    expect(r.isError).toBeUndefined();
    expect(commands).toEqual(["tail -n 50 /var/log/app.log"]);
    // 注入面：元字符路径拒绝（防 tail 之外命令拼接）
    const bad = await byName("host_logs_tail").handler({
      targetId: t.id,
      file: "/var/log/a;rm -rf /",
    });
    expect(bad.isError).toBe(true);
    expect(commands.length).toBe(1);
  });

  it("host_logs_clean：原子截断命令形态（tmp+mv）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, "u1");
    const commands: string[] = [];
    const { byName } = tools(store, { id: "u1", role: "user" }, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "1000 /var/log/app.log", stderr: "" };
    });
    const r = await byName("host_logs_clean").handler({
      targetId: t.id,
      file: "/var/log/app.log",
      keepLines: 1000,
    });
    expect(r.isError).toBeUndefined();
    expect(commands[0]).toBe(
      "tail -n 1000 /var/log/app.log > /var/log/app.log.donger-tmp && mv /var/log/app.log.donger-tmp /var/log/app.log && wc -l /var/log/app.log",
    );
  });

  it("deploy_targets_list：user 只见本人", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const mine = await seed(store, "u1");
    await seed(store, "u2");
    const { byName } = tools(store, { id: "u1", role: "user" });
    const r = await byName("deploy_targets_list").handler({});
    const text = (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain(mine.id);
    expect(text).not.toContain("(u2 的 service 名重复，按 id 断言)");
    // u2 的 target id 不出现在列表
    const all = await store.listTargets();
    const other = all.find((x) => x.ownerId === "u2");
    expect(text).not.toContain(other?.id ?? "u2-target-id");
  });

  it("service_deploy：走 executor（trigger=agent）并回报成功", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const t = await seed(store, "u1");
    const { byName } = tools(store, { id: "u1", role: "user" });
    const r = await byName("service_deploy").handler({ targetId: t.id });
    expect(r.isError).toBeUndefined();
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toContain("部署成功");
    const orders = await store.listOrders(t.id);
    expect(orders[0]?.trigger).toBe("agent");
  });
});

describe("host-ops 审批门（default-gates 注册）", () => {
  const g = createDefaultGates();
  it("三个写操作工具命中 host-ops force 门", () => {
    for (const t of ["service_deploy", "service_restart", "host_logs_clean"]) {
      const m = g.match(`mcp__donger-host__${t}`, {});
      expect(m?.gateId).toBe("host-ops");
      expect(m?.force).toBe(true);
    }
  });
  it("只读诊断工具不设门", () => {
    for (const t of [
      "host_status",
      "host_disk_usage",
      "host_process_top",
      "host_logs_tail",
      "deploy_status",
      "deploy_targets_list",
    ]) {
      expect(g.match(`mcp__donger-host__${t}`, {})).toBeUndefined();
    }
  });
});
