import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EngineRuntimeService,
  type EngineRuntimeServiceDeps,
} from "../../src/adapters/engine-runtime-service.js";
import { SqliteEngineRuntimeStore } from "../../src/adapters/sqlite-engine-runtime-store.js";
import type { EngineRuntimeRecord } from "../../src/ports/engine-runtime-store.js";
import type { SystemEvent } from "../../src/ports/system-event-store.js";

let db: Database.Database;
let store: SqliteEngineRuntimeStore;
let tmp: string;
let events: Array<{ type: string; detail: string }>;
let deps: EngineRuntimeServiceDeps;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteEngineRuntimeStore(db);
  store.migrate();
  tmp = mkdtempSync(join(tmpdir(), "engine-rt-"));
  events = [];
  deps = {
    store,
    systemEvents: {
      async record(e: Partial<SystemEvent> & { type: string }): Promise<SystemEvent> {
        events.push({ type: e.type, detail: e.detail ?? "" });
        return { id: "1", createdAt: "t", ... (e as SystemEvent) };
      },
      async list(): Promise<SystemEvent[]> {
        return [];
      },
    },
    enginesDir: join(tmp, "engines"),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    env: {},
  };
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** 假 CLI：--version 输出 1.2.3、exit 0；exitCode 可控失败 */
function writeFakeCli(name: string, exitCode = 0): string {
  const p = join(tmp, name);
  writeFileSync(
    p,
    `process.stdout.write("zcode 1.2.3\\n"); process.exit(${exitCode});\n`,
    "utf8",
  );
  return p;
}

describe("engine_runtimes 迁移种子", () => {
  it("anthropic/openai=bundled/ready，zcode=missing", async () => {
    expect((await store.get("anthropic"))?.status).toBe("ready");
    expect((await store.get("openai"))?.sourceKind).toBe("bundled");
    expect((await store.get("zcode"))?.status).toBe("missing");
  });
});

describe("解析链（env → 注册表 → 降级）", () => {
  it("env 显式配置优先且视为钉版", () => {
    const cli = writeFakeCli("env-cli.cjs");
    const svc = new EngineRuntimeService({ ...deps, env: { DONGER_ZCODE_CLI_PATH: cli } });
    const info = svc.resolveCliPathInfo();
    expect(info).toMatchObject({ path: cli, pinned: true, source: "env" });
  });

  it("注册表 ready 行被消费（local 直引 managed=0 同样生效，e2e 实锤回归）；drifted/error 不被消费（fail-closed）", async () => {
    const cli = writeFakeCli("registry-cli.cjs");
    await store.upsert({
      sdkType: "zcode",
      sourceKind: "local",
      installedPath: cli,
      managed: false,
      status: "ready",
      updatedAt: "t",
    });
    const svc = new EngineRuntimeService(deps);
    await svc.start();
    expect(svc.resolveCliPathInfo()).toMatchObject({ source: "registry", pinned: true });
    // drifted → 解析链落到降级层（不再消费该行）
    const row = await store.get("zcode");
    await store.upsert({ ...row!, status: "drifted" });
    await svc.start();
    const info = svc.resolveCliPathInfo();
    expect(info?.source).not.toBe("registry");
  });
});

describe("install local 来源", () => {
  it("冒烟通过 → ready + sha256 + 版本回填；失败 → error 且不留受管半成品", async () => {
    const svc = new EngineRuntimeService(deps);
    const cli = writeFakeCli("ok-cli.cjs");
    const okResult = await svc.install("zcode", { sourceKind: "local", sourceRef: cli });
    expect(okResult.ok).toBe(true);
    expect(okResult.record).toMatchObject({ status: "ready", pinnedVersion: "1.2.3", managed: false });

    const bad = writeFakeCli("bad-cli.cjs", 1);
    const failResult = await svc.install("zcode", { sourceKind: "local", sourceRef: bad });
    expect(failResult.ok).toBe(false);
    expect((await store.get("zcode"))?.status).toBe("error");
  });

  it("local 路径不存在拒绝", async () => {
    const svc = new EngineRuntimeService(deps);
    const r = await svc.install("zcode", { sourceKind: "local", sourceRef: join(tmp, "nope.cjs") });
    expect(r.ok).toBe(false);
  });

  it("内置引擎拒绝安装", async () => {
    const svc = new EngineRuntimeService(deps);
    expect((await svc.install("anthropic", { sourceKind: "discover" })).ok).toBe(false);
  });
});

describe("冒烟与漂移", () => {
  it("手动冒烟刷新版本与 sha256；工件消失 → error", async () => {
    const svc = new EngineRuntimeService(deps);
    const cli = writeFakeCli("smoke-cli.cjs");
    await svc.install("zcode", { sourceKind: "local", sourceRef: cli });
    const smokeOk = await svc.smoke("zcode");
    expect(smokeOk.ok).toBe(true);
    expect(smokeOk.version).toBe("1.2.3");

    rmSync(cli);
    const smokeGone = await svc.smoke("zcode");
    expect(smokeGone.ok).toBe(false);
    expect((await store.get("zcode"))?.status).toBe("error");
  });

  it("工件被外部修改 → drifted + system_events 报警（不自动更换）", async () => {
    const cli = writeFakeCli("drift-cli.cjs");
    await store.upsert({
      sdkType: "zcode",
      sourceKind: "local",
      installedPath: cli,
      sha256: "deadbeef",
      managed: false, // 直引模式不参与漂移检测
      status: "ready",
      updatedAt: "t",
    });
    const svc = new EngineRuntimeService(deps);
    expect(await svc.checkDrift()).toBe(0);

    await store.upsert({ ...(await store.get("zcode"))!, managed: true });
    expect(await svc.checkDrift()).toBe(1);
    expect((await store.get("zcode"))?.status).toBe("drifted");
    expect(events.some((e) => e.type === "engine_drifted")).toBe(true);
  });

  it("启动清扫：遗留 installing → error", async () => {
    await store.upsert({
      sdkType: "zcode",
      sourceKind: "discover",
      managed: true,
      status: "installing",
      updatedAt: "t",
    });
    const svc = new EngineRuntimeService(deps);
    await svc.start();
    expect((await store.get("zcode"))?.status).toBe("error");
    expect((await store.get("zcode"))?.lastError).toContain("中断");
  });
});

describe("status 汇总", () => {
  it("返回工件行+解析链现状", async () => {
    const cli = writeFakeCli("status-cli.cjs");
    const svc = new EngineRuntimeService({ ...deps, env: { DONGER_ZCODE_CLI_PATH: cli } });
    const s = await svc.status();
    expect(s.runtimes.map((r) => r.sdkType)).toEqual(["anthropic", "openai", "zcode"]);
    expect(s.resolution.zcode).toMatchObject({ source: "env", pinned: true });
  });
});

describe("RoutingAgentRunner 引擎门禁", async () => {
  const { RoutingAgentRunner } = await import("../../src/adapters/routing-agent-runner.js");
  const { FakeAgentRunner } = await import("../../src/adapters/fake-agent-runner.js");

  function runnerWith(gate?: (sdkType: string) => boolean) {
    const fake = new FakeAgentRunner();
    return {
      fake,
      runner: new RoutingAgentRunner(
        fake,
        fake,
        fake,
        gate as never,
      ),
    };
  }

  it("门禁拒绝：停用引擎的轮 fail-closed 抛错（不静默换引擎）", async () => {
    const { runner } = runnerWith((sdk) => sdk !== "zcode");
    const task = { id: "t1" } as never;
    const opts = { llm: { sdkType: "zcode" } } as never;
    expect(() => runner.run(task, opts, {} as never)).toThrow(/已停用/);
  });

  it("门禁放行与未注入 gate（向后兼容存量构造）", () => {
    const enabled = runnerWith(() => true);
    expect(() =>
      enabled.runner.run({ id: "t" } as never, { llm: { sdkType: "zcode" } } as never, {} as never),
    ).not.toThrow();
    const legacy = runnerWith();
    expect(() =>
      legacy.runner.run({ id: "t" } as never, { llm: {} } as never, {} as never),
    ).not.toThrow();
  });
});
