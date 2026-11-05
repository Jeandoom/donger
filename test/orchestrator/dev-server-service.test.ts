import { afterEach, describe, expect, it } from "vitest";
import { DevServerError, DevServerService } from "../../src/orchestrator/dev-server-service.js";
import { SqliteSessionRuntimeStore } from "../../src/adapters/sqlite-session-runtime-store.js";
import Database from "better-sqlite3";

/**
 * dev server 托管服务契约（spec 2026-11-04-webgame-dev-loop-design §3.3）：
 * 平台 spawn + {port} 占位注入、幂等起服、就绪探测失败回收、并发上限、
 * 停止落账、闲置回收、boot 对账。子进程为真实 node http 服务（仓库先例：真子进程测试）。
 */

const UPSTREAM_CMD =
  'node -e "require(\'http\').createServer((q,s)=>s.end(\'up:\'+q.url)).listen({port}, \'127.0.0.1\')"';

function makeService(overrides?: Partial<Parameters<typeof buildDeps>[0]>) {
  const store = new SqliteSessionRuntimeStore(new Database(":memory:"));
  store.migrate();
  const deps = buildDeps(store, overrides);
  return { store, service: new DevServerService(deps) };
}

function buildDeps(
  store: SqliteSessionRuntimeStore,
  overrides?: {
    maxTotal?: number;
    maxPerUser?: number;
    idleMs?: number;
    readyTimeoutMs?: number;
    drain?: { shouldRejectNewTurn(): boolean };
  },
) {
  return {
    store,
    maxTotal: overrides?.maxTotal,
    maxPerUser: overrides?.maxPerUser,
    idleMs: overrides?.idleMs,
    readyTimeoutMs: overrides?.readyTimeoutMs ?? 30_000,
    drain: overrides?.drain,
    log: () => undefined,
  };
}

const started: DevServerService[] = [];
function track(service: DevServerService): DevServerService {
  started.push(service);
  return service;
}

afterEach(async () => {
  for (const s of started.splice(0)) await s.dispose().catch(() => undefined);
});

async function start(
  service: DevServerService,
  conversationId: string,
  ownerId = "user-1",
  cmd?: string,
) {
  return service.start({
    conversationId,
    ownerId,
    agentId: null,
    cwd: process.cwd(),
    cmd,
  });
}

describe("DevServerService", () => {
  it("start：占位口注入 + 就绪后登记 + 反代上游可解析", async () => {
    const { service, store } = makeService();
    track(service);
    const handle = await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    expect(handle.reused).toBe(false);
    expect(handle.url).toBe("/preview/conv-1/");
    expect(handle.port).toBeGreaterThan(0);
    const row = await store.get("conv-1");
    expect(row?.status).toBe("running");
    expect(row?.cmd).toContain(`.listen(${handle.port}`);
    expect(await service.resolveUpstream("conv-1")).toBe(handle.port);
  });

  it("start 幂等：已运行返回同口 reused=true；stop 后可重启新口", async () => {
    const { service } = makeService();
    track(service);
    const first = await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    const again = await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    expect(again.reused).toBe(true);
    expect(again.port).toBe(first.port);
    expect(await service.stop("conv-1")).toBe(true);
    expect(await service.resolveUpstream("conv-1")).toBeNull();
    const restarted = await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    expect(restarted.reused).toBe(false);
  });

  it("就绪超时：抛 not_ready（带日志尾），无残留账行与活进程", async () => {
    const { service, store } = makeService({ readyTimeoutMs: 1_500 });
    track(service);
    const neverListens = 'node -e "setTimeout(()=>{},60000)"';
    const err = await start(service, "conv-1", "user-1", neverListens).catch((e) => e);
    expect(err).toBeInstanceOf(DevServerError);
    expect(err.code).toBe("not_ready");
    expect(err.detail?.logs?.length).toBeGreaterThan(0);
    // 失败路径未到 register：不落行（resolveUpstream 读行语义=null）
    expect(await store.get("conv-1")).toBeUndefined();
    expect(await service.resolveUpstream("conv-1")).toBeNull();
  });

  it("并发上限：全局与单用户两档各自拦截，释放后可再起", async () => {
    const { service } = makeService({ maxTotal: 2, maxPerUser: 1 });
    track(service);
    await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    // 单用户档先拦（同用户第二会话）
    await expect(start(service, "conv-2", "user-1", UPSTREAM_CMD)).rejects.toMatchObject({
      code: "limit_user",
    });
    // 换用户起满全局额度后，第三个会话撞全局档
    await start(service, "conv-2", "user-2", UPSTREAM_CMD);
    await expect(start(service, "conv-3", "user-3", UPSTREAM_CMD)).rejects.toMatchObject({
      code: "limit_total",
    });
    // 释放一席后可再起
    await service.stop("conv-1");
    const handle = await start(service, "conv-3", "user-3", UPSTREAM_CMD);
    expect(handle.reused).toBe(false);
  });

  it("排水期拒启", async () => {
    const { service } = makeService({ drain: { shouldRejectNewTurn: () => true } });
    track(service);
    await expect(start(service, "conv-1", "user-1", UPSTREAM_CMD)).rejects.toMatchObject({
      code: "draining",
    });
  });

  it("reapIdle：闲置行回收；boot 对账清 running", async () => {
    const { service, store } = makeService({ idleMs: 50 });
    track(service);
    await start(service, "conv-1", "user-1", UPSTREAM_CMD);
    // 全量并行下 CPU 饥饿会拉长真实时延，留足裕量再触发闲置判定
    await new Promise((r) => setTimeout(r, 500));
    expect(await service.reapIdle()).toEqual(["conv-1"]);
    expect((await store.get("conv-1"))?.status).toBe("stopped");
    // boot 对账：手工插入 running 行（模拟上次进程遗留）
    await store.register({ conversationId: "conv-legacy", ownerId: "u", agentId: null, port: 1, cmd: "x", pid: null });
    expect(await service.reconcileAtBoot()).toBe(1);
    expect(await store.listRunning()).toEqual([]);
  });
});
