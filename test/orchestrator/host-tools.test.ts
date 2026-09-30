import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteHostStore } from "../../src/adapters/sqlite-host-store.js";
import { HostInputSchema } from "../../src/domain/host.js";
import { createDefaultGates } from "../../src/orchestrator/default-gates.js";
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
  const store = new SqliteHostStore(db);
  store.migrate();
  return { db, store };
}

async function seed(store: SqliteHostStore, ownerId: string, enabled = true) {
  return store.create(
    HostInputSchema.parse({
      name: "homedb",
      host: "homedb.example.com",
      port: 22,
      username: "ubuntu",
      credentialCode: "ssh-homedb",
      enabled,
    }),
    ownerId,
  );
}

function tools(
  store: SqliteHostStore,
  viewer: { id: string; role: "admin" | "user" },
  sshRunner?: SshCommandRunner,
) {
  const runner =
    sshRunner ?? ((async () => ({ exitCode: 0, stdout: "out", stderr: "" })) as SshCommandRunner);
  const defs = hostToolDefinitions({
    viewer,
    hostStore: store,
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

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe("canViewerUseHostTools（挂载判定）", () => {
  it("admin 恒可；host 属主可；他人不可；属主但 disabled 不可", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    await seed(store, "u1");
    expect(await canViewerUseHostTools(store, { id: "a1", role: "admin" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u1", role: "user" })).toBe(true);
    expect(await canViewerUseHostTools(store, { id: "u2", role: "user" })).toBe(false);
    const { db: db2, store: store2 } = makeStore();
    dbs.push(db2);
    await seed(store2, "u1", false);
    expect(await canViewerUseHostTools(store2, { id: "u1", role: "user" })).toBe(false);
  });
});

describe("donger-host 工具集 v2（主机登记制）", () => {
  it("非属主非 admin 访问他人主机 → isError；不存在同理（存在性不泄漏）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await seed(store, "u1");
    const { byName } = tools(store, { id: "u2", role: "user" });
    const r = await byName("host_status").handler({ hostId: h.id });
    expect(r.isError).toBe(true);
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toContain("无权访问");
    const missing = await byName("host_status").handler({ hostId: "nope" });
    expect(missing.isError).toBe(true);
  });

  it("host_logs_tail：固定命令模板 + 元字符 file 拒绝", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await seed(store, "u1");
    const commands: string[] = [];
    const { byName } = tools(store, { id: "u1", role: "user" }, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "log", stderr: "" };
    });
    const r = await byName("host_logs_tail").handler({
      hostId: h.id,
      file: "/var/log/app.log",
      lines: 50,
    });
    expect(r.isError).toBeUndefined();
    expect(commands).toEqual(["tail -n 50 /var/log/app.log"]);
    const bad = await byName("host_logs_tail").handler({
      hostId: h.id,
      file: "/var/log/a;rm -rf /",
    });
    expect(bad.isError).toBe(true);
    expect(commands.length).toBe(1);
  });

  it("host_exec：命令透传（agent 构造部署命令的唯一写通道）", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await seed(store, "u1");
    const commands: string[] = [];
    const { byName } = tools(store, { id: "u1", role: "user" }, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "deployed", stderr: "" };
    });
    const deployCmd = "cd /srv/app && git pull origin master && sudo systemctl restart stock";
    const r = await byName("host_exec").handler({ hostId: h.id, command: deployCmd });
    expect(r.isError).toBeUndefined();
    expect(commands).toEqual([deployCmd]);
    // 多行命令拒绝（命令注入面收口）
    const bad = await byName("host_exec").handler({ hostId: h.id, command: "cd /x\nrm -rf /" });
    expect(bad.isError).toBe(true);
  });

  it("host_logs_clean：原子截断命令形态", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await seed(store, "u1");
    const commands: string[] = [];
    const { byName } = tools(store, { id: "u1", role: "user" }, async (_e, _a, cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "1000 /var/log/app.log", stderr: "" };
    });
    await byName("host_logs_clean").handler({
      hostId: h.id,
      file: "/var/log/app.log",
      keepLines: 1000,
    });
    expect(commands[0]).toBe(
      "tail -n 1000 /var/log/app.log > /var/log/app.log.donger-tmp && mv /var/log/app.log.donger-tmp /var/log/app.log && wc -l /var/log/app.log",
    );
  });

  it("disabled 主机：所有工具拒绝执行", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const h = await seed(store, "u1", false);
    const { byName } = tools(store, { id: "u1", role: "user" });
    const r = await byName("host_status").handler({ hostId: h.id });
    expect(r.isError).toBe(true);
  });

  it("hosts_list：user 只见本人", async () => {
    const { db, store } = makeStore();
    dbs.push(db);
    const mine = await seed(store, "u1");
    const other = await seed(store, "u2");
    const { byName } = tools(store, { id: "u1", role: "user" });
    const text = ((await byName("hosts_list").handler({})) as { content: Array<{ text: string }> })
      .content[0]?.text;
    expect(text).toContain(mine.id);
    expect(text).not.toContain(other.id);
  });
});

describe("host-ops 审批门（default-gates v2）", () => {
  const g = createDefaultGates();
  it("host_exec / host_logs_clean 命中 force 门", () => {
    for (const t of ["host_exec", "host_logs_clean"]) {
      const m = g.match(`mcp__donger-host__${t}`, {});
      expect(m?.gateId).toBe("host-ops");
      expect(m?.force).toBe(true);
    }
  });
  it("只读诊断工具不设门", () => {
    for (const t of [
      "hosts_list",
      "host_status",
      "host_disk_usage",
      "host_process_top",
      "host_logs_tail",
    ]) {
      expect(g.match(`mcp__donger-host__${t}`, {})).toBeUndefined();
    }
  });
  it("v1 退役工具不再挂门", () => {
    for (const t of ["service_deploy", "service_restart"]) {
      expect(g.match(`mcp__donger-host__${t}`, {})).toBeUndefined();
    }
  });
});
