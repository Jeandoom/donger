// 会话 dev server 托管服务（2026-11-04 网站游戏开发闭环 spec §3.3）：
// 平台 spawn（127.0.0.1 随机口，{port} 占位注入）+ 日志环 + 全局/单用户并发上限
// + 闲置回收 + 排水期拒启 + 崩溃自动落账。进程不跨重启恢复（boot 时 running 全落 stopped）。

import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { SessionRuntimeEntry, SessionRuntimeStore } from "../ports/session-runtime-store.js";

/** 缺省启动命令：vite 系约定（next 等由 agent 传 cmd 覆盖，技能内文档化） */
export const DEV_SERVER_DEFAULT_CMD = "npm run dev -- --port {port} --strictPort --host 127.0.0.1";

export class DevServerError extends Error {
  constructor(
    readonly code:
      | "draining"
      | "limit_total"
      | "limit_user"
      | "already_running"
      | "not_found"
      | "not_ready"
      | "bad_cmd",
    message: string,
    readonly detail?: { logs?: string[] },
  ) {
    super(message);
  }
}

export interface DevServerStartRequest {
  conversationId: string;
  ownerId: string;
  agentId: string | null;
  /** 项目根（编排侧闭包绑定：git agent=会话 reposRoot，否则 agent workspace） */
  cwd: string;
  /** 子目录（相对 cwd，穿越防护由编排侧 resolveWithinRoots 先行） */
  dir?: string;
  /** 含 {port} 占位的启动命令 */
  cmd?: string;
}

export interface DevServerHandle {
  conversationId: string;
  port: number;
  /** 平台同源预览路径（反代消费） */
  url: string;
  reused: boolean;
}

export interface DevServerServiceDeps {
  store: SessionRuntimeStore;
  /** 全局并发上限（缺省 4） */
  maxTotal?: number;
  /** 单用户并发上限（缺省 2） */
  maxPerUser?: number;
  /** 闲置回收阈值毫秒（缺省 30 分钟；lastAccessAt 由反代续期） */
  idleMs?: number;
  /** 就绪探测超时毫秒（缺省 30s） */
  readyTimeoutMs?: number;
  /** 排水闸（热发布优雅停机期拒启） */
  drain?: { shouldRejectNewTurn(): boolean };
  now?: () => number;
  log?: (line: string) => void;
}

interface LiveProcess {
  child: ChildProcess;
  logs: string[];
  cwd: string;
  exitWait: Promise<void>;
}

const LOG_RING_MAX = 200;

export class DevServerService {
  private readonly live = new Map<string, LiveProcess>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DevServerServiceDeps) {}

  async start(req: DevServerStartRequest): Promise<DevServerHandle> {
    const existing = await this.deps.store.get(req.conversationId);
    if (existing?.status === "running") {
      const still = this.live.get(req.conversationId);
      if (still && !still.child.killed && still.child.exitCode === null) {
        return { conversationId: req.conversationId, port: existing.port, url: previewUrl(req.conversationId), reused: true };
      }
      // 账实不符（行活着进程没了）：落账后走重启
      await this.deps.store.markStopped(req.conversationId);
    }
    if (this.deps.drain?.shouldRejectNewTurn()) {
      throw new DevServerError("draining", "服务正在更新发布，dev server 暂不能启动，请稍后重试");
    }
    const running = await this.deps.store.listRunning();
    const maxTotal = this.deps.maxTotal ?? 4;
    if (running.length >= maxTotal) {
      throw new DevServerError(
        "limit_total",
        `平台 dev server 并发已达上限（${running.length}/${maxTotal}）：请先停止不再使用的会话预览`,
      );
    }
    const maxPerUser = this.deps.maxPerUser ?? 2;
    const mine = running.filter((r) => r.ownerId === req.ownerId).length;
    if (mine >= maxPerUser) {
      throw new DevServerError(
        "limit_user",
        `你的 dev server 并发已达上限（${mine}/${maxPerUser}）：可对旧会话调用 dev_stop 释放`,
      );
    }
    const rawCmd = (req.cmd ?? DEV_SERVER_DEFAULT_CMD).trim();
    if (rawCmd.length === 0 || rawCmd.length > 500) {
      throw new DevServerError("bad_cmd", "启动命令非法（空或超长）");
    }
    const port = await allocatePort();
    const cwd = req.dir ? joinPath(req.cwd, req.dir) : req.cwd;
    const cmd = rawCmd.replaceAll("{port}", String(port));
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const live: LiveProcess = {
      child,
      logs: [`$ ${cmd}`],
      cwd,
      exitWait: new Promise<void>(() => {}),
    };
    const onData = (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        live.logs.push(line);
        if (live.logs.length > LOG_RING_MAX) live.logs.splice(0, live.logs.length - LOG_RING_MAX);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    live.exitWait = new Promise<void>((resolve) => {
      child.on("exit", (code) => {
        live.logs.push(`[exit code=${code ?? "signal"}]`);
        this.live.delete(req.conversationId);
        // 异常退出自动落账（dev_stop 主动停时行已先置 stopped，此处幂等）
        void this.deps.store.markStopped(req.conversationId).catch(() => undefined);
        resolve();
      });
      child.on("error", (err) => {
        live.logs.push(`[spawn error] ${err.message}`);
      });
    });
    this.live.set(req.conversationId, live);
    this.deps.log?.(`[dev-server] conv=${req.conversationId} port=${port} cwd=${cwd}`);

    const ready = await waitForPort(port, this.deps.readyTimeoutMs ?? 30_000);
    if (!ready) {
      const tail = live.logs.slice(-15);
      await this.stop(req.conversationId);
      throw new DevServerError(
        "not_ready",
        `dev server ${this.deps.readyTimeoutMs ?? 30_000}ms 内未监听端口 ${port}（命令见日志尾）`,
        { logs: tail },
      );
    }
    await this.deps.store.register({
      conversationId: req.conversationId,
      ownerId: req.ownerId,
      agentId: req.agentId,
      port,
      cmd,
      pid: child.pid ?? null,
    });
    return { conversationId: req.conversationId, port, url: previewUrl(req.conversationId), reused: false };
  }

  /** 反代取上游端口；未启动/已死返回 null */
  async resolveUpstream(conversationId: string): Promise<number | null> {
    const entry = await this.deps.store.get(conversationId);
    if (!entry || entry.status !== "running") return null;
    const live = this.live.get(conversationId);
    if (!live || live.child.exitCode !== null) return null;
    return entry.port;
  }

  async touch(conversationId: string): Promise<void> {
    await this.deps.store.touch(conversationId);
  }

  async status(conversationId: string): Promise<SessionRuntimeEntry | undefined> {
    const entry = await this.deps.store.get(conversationId);
    if (!entry || entry.status !== "running") return undefined;
    const live = this.live.get(conversationId);
    if (!live || live.child.exitCode !== null) return undefined;
    return entry;
  }

  logs(conversationId: string, lines = 30): string[] {
    const live = this.live.get(conversationId);
    return live ? live.logs.slice(-Math.min(Math.max(lines, 1), LOG_RING_MAX)) : [];
  }

  /** 主动停止（树杀）并落账；未在运行返回 false */
  async stop(conversationId: string): Promise<boolean> {
    const live = this.live.get(conversationId);
    const marked = await this.deps.store.markStopped(conversationId);
    if (!live) return marked;
    killTree(live.child);
    await Promise.race([live.exitWait, sleep(5_000)]);
    this.live.delete(conversationId);
    return true;
  }

  /** 闲置回收 + 孤儿对账（周期调度；返回本次停止的会话数） */
  async reapIdle(): Promise<string[]> {
    const now = this.deps.now ?? Date.now;
    const idleMs = this.deps.idleMs ?? 30 * 60_000;
    const stopped: string[] = [];
    for (const entry of await this.deps.store.listRunning()) {
      const live = this.live.get(entry.conversationId);
      if (!live || live.child.exitCode !== null) {
        await this.deps.store.markStopped(entry.conversationId);
        stopped.push(entry.conversationId);
        continue;
      }
      if (now() - Date.parse(entry.lastAccessAt) > idleMs) {
        await this.stop(entry.conversationId);
        stopped.push(entry.conversationId);
        this.deps.log?.(`[dev-server] idle reap conv=${entry.conversationId}`);
      }
    }
    return stopped;
  }

  /** 周期回收循环（进程内 setInterval）。返回停止函数。 */
  startReaper(intervalMs = 5 * 60_000): () => void {
    if (this.reaperTimer) return () => undefined;
    this.reaperTimer = setInterval(() => {
      void this.reapIdle().catch(() => undefined);
    }, intervalMs);
    this.reaperTimer.unref?.();
    return () => {
      if (this.reaperTimer) clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    };
  }

  /** 平台启动对账：上一次进程的 running 行全部落 stopped（进程不跨重启） */
  async reconcileAtBoot(): Promise<number> {
    return this.deps.store.markAllStopped();
  }

  /** 停机排水：杀掉全部存活 dev server */
  async dispose(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    for (const convId of [...this.live.keys()]) {
      await this.stop(convId).catch(() => undefined);
    }
  }
}

export function previewUrl(conversationId: string): string {
  return `/preview/${conversationId}/`;
}

/** 临时端口分配（McpHttpBridge 同款 listen(0) 惯例；极小概率竞态由 strictPort 兜底暴露） */
async function allocatePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("port allocate failed"))));
    });
    srv.on("error", reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (open) return true;
    await sleep(500);
  }
  return false;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: true,
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // 落到普通 kill
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3_000).unref?.();
  } catch {
    // 进程已退
  }
}

function joinPath(root: string, sub: string): string {
  return isAbsolute(sub) ? sub : resolvePath(root, sub);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
