import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlitePluginStore } from "../../src/adapters/sqlite-plugin-store.js";
import {
  disableBlockers,
  isPluginEnabled,
  unmetRequires,
  type PluginView,
} from "../../src/domain/plugin.js";
import { PluginHost, scanBuiltinManifests } from "../../src/plugins/plugin-host.js";

let db: Database.Database;
let store: SqlitePluginStore;
let dir: string;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqlitePluginStore(db);
  store.migrate();
  dir = mkdtempSync(join(tmpdir(), "plugins-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(id: string, body: Record<string, unknown>): void {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "plugin.json"), JSON.stringify(body), "utf8");
}

function view(over: Partial<PluginView> & { id: string }): PluginView {
  return {
    kind: "capability",
    core: false,
    stoppable: true,
    source: "builtin",
    enabled: true,
    status: "ready",
    requires: [],
    title: over.id,
    installedAt: "t",
    updatedAt: "t",
    ...over,
  };
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

describe("scanBuiltinManifests", () => {
  it("解析合法 manifest 并拒绝 id 与目录名不一致的条目", () => {
    writeManifest("alpha", { id: "alpha", kind: "capability", title: "A", core: true });
    writeManifest("beta", { id: "gamma", kind: "capability", title: "B" });
    const scan = scanBuiltinManifests(dir, silentLogger);
    expect([...scan.manifests.keys()]).toEqual(["alpha"]);
    expect(scan.errors).toHaveLength(1);
  });

  it("坏 JSON fail-soft 不炸", () => {
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "plugin.json"), "{oops", "utf8");
    const scan = scanBuiltinManifests(dir, silentLogger);
    expect(scan.manifests.size).toBe(0);
    expect(scan.errors).toHaveLength(1);
  });

  it("manifest 缺省字段按 schema 填充（core=false/stoppable=true/requires=[]）", () => {
    writeManifest("plain", { id: "plain", kind: "capability", title: "P" });
    const scan = scanBuiltinManifests(dir, silentLogger);
    expect(scan.manifests.get("plain")).toMatchObject({
      core: false,
      stoppable: true,
      requires: [],
    });
  });
});

describe("PluginHost reconcile", () => {
  it("首次 init 登记全部 manifest 且默认启用（存量零变化）", async () => {
    writeManifest("engine.claude", {
      id: "engine.claude",
      kind: "engine",
      title: "Claude",
      core: true,
      scope: "platform",
    });
    writeManifest("kb", { id: "kb", kind: "capability", title: "知识库", scope: "agent" });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    const snap = await host.init();
    expect(snap.plugins).toHaveLength(2);
    expect(snap.plugins.every((p) => p.enabled)).toBe(true);
    // engine 来源归 bundled
    expect(snap.plugins.find((p) => p.id === "engine.claude")?.source).toBe("bundled");
  });

  it("对账幂等：重复 init 不漂移", async () => {
    writeManifest("a", { id: "a", kind: "capability", title: "A", requires: ["b"] });
    writeManifest("b", { id: "b", kind: "capability", title: "B" });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    await host.init();
    const first = await store.list();
    await host.init();
    expect(await store.list()).toEqual(first);
  });

  it("manifest 移除后对账标 missing；pack 行不动", async () => {
    writeManifest("gone", { id: "gone", kind: "capability", title: "G" });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    await host.init();
    rmSync(join(dir, "gone"), { recursive: true, force: true });
    await store.upsert({
      id: "pack:x",
      kind: "pack",
      core: false,
      stoppable: true,
      source: "git",
      enabled: true,
      status: "ready",
      requires: [],
      installedAt: "t",
      updatedAt: "t",
    });
    await host.init();
    expect((await store.get("gone"))?.status).toBe("missing");
    expect((await store.get("pack:x"))?.status).toBe("ready");
  });

  it("admin 停用决策不被对账覆盖；core/stoppable 以 manifest 为准纠偏", async () => {
    writeManifest("c", { id: "c", kind: "capability", title: "C", core: true, stoppable: false });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    await host.init();
    await store.setEnabled("c", false);
    // manifest 改动 stoppable（模拟版本演进）
    writeManifest("c", { id: "c", kind: "capability", title: "C", core: true, stoppable: true });
    await host.init();
    const row = await store.get("c");
    expect(row?.enabled).toBe(false);
    expect(row?.stoppable).toBe(true);
  });
});

describe("setEnabled 前置校验", () => {
  it("停用被依赖模块被拒（409 链路文案）；先停依赖方后放行", async () => {
    writeManifest("mcp", { id: "mcp", kind: "capability", title: "MCP", requires: [] });
    writeManifest("conn", { id: "conn", kind: "capability", title: "连接器", requires: ["mcp"] });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    await host.init();
    const blocked = await host.setEnabled("mcp", false);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers[0]).toContain("连接器");
    await host.setEnabled("conn", false);
    const ok = await host.setEnabled("mcp", false);
    expect(ok.ok).toBe(true);
  });

  it("stoppable=false 拒停；停用后重新启用校验 requires", async () => {
    writeManifest("tasks", {
      id: "tasks",
      kind: "capability",
      title: "任务",
      core: true,
      stoppable: false,
    });
    writeManifest("wf", { id: "wf", kind: "capability", title: "工作流", requires: ["tasks"] });
    const host = new PluginHost({ builtinDir: dir, store, log: silentLogger });
    await host.init();
    expect((await host.setEnabled("tasks", false)).ok).toBe(false);
    await host.setEnabled("tasks", false); // 直接落库模拟（绕过校验的存量数据）
    await store.setEnabled("tasks", false);
    const reEnable = await host.setEnabled("wf", true);
    expect(reEnable.ok).toBe(false);
    expect(reEnable.blockers[0]).toContain("任务");
  });
});

describe("domain 依赖校验纯函数", () => {
  const all: PluginView[] = [
    view({ id: "credentials", title: "凭证", core: true, stoppable: true }),
    view({ id: "host-exec", title: "远程主机执行", requires: ["credentials"] }),
    view({ id: "audit", title: "审计", core: true, stoppable: false }),
    view({ id: "dead", title: "死模块", enabled: false, requires: ["audit"] }),
  ];

  it("disableBlockers：不可停 + enabled 依赖方 + 不存在", () => {
    expect(disableBlockers(all, "audit")).toHaveLength(1);
    expect(disableBlockers(all, "credentials")).toHaveLength(1);
    expect(disableBlockers(all, "host-exec")).toHaveLength(0);
    expect(disableBlockers(all, "nope")).toHaveLength(1);
    // enabled 依赖方构成阻塞；已停用的依赖方不构成阻塞
    expect(disableBlockers([...all, view({ id: "x", requires: ["dead"] })], "dead")).toHaveLength(1);
    expect(
      disableBlockers([...all, view({ id: "x", enabled: false, requires: ["dead"] })], "dead"),
    ).toHaveLength(0);
  });

  it("unmetRequires：依赖未启用清单", () => {
    expect(unmetRequires(all, "host-exec")).toEqual([]);
    expect(unmetRequires([...all, view({ id: "y", requires: ["dead"] })], "y")).toEqual([
      "死模块",
    ]);
    expect(unmetRequires(all, "nope")).toHaveLength(1);
  });

  it("isPluginEnabled fail-open：快照缺失/行缺失均视为启用", () => {
    expect(isPluginEnabled(undefined, "x")).toBe(true);
    expect(isPluginEnabled({ plugins: all, generatedAt: "t" }, "nope")).toBe(true);
    expect(isPluginEnabled({ plugins: all, generatedAt: "t" }, "dead")).toBe(false);
  });
});
