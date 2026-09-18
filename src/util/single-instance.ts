// 单实例互斥：防止多个 donger dev 进程并存（曾出现双 tsx 进程同端口僵死）。
// 锁文件记录持有者 pid；第二实例发现存活持有者则等待短暂宽限（覆盖 tsx watch
// 重启时旧进程尚未退尽的窗口）后退出。崩溃残留的锁经 pid 存活探测自动接管。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

interface LockContent {
  pid: number;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但无信号权限，同样视为存活
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(lockPath: string): LockContent | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as LockContent;
    return typeof raw.pid === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 获取单实例锁；已有存活实例时最多等待 graceMs 让其退出（tsx watch 重启场景），
 * 仍存活则报错退出本进程。成功持锁后注册 exit 钩子清理锁文件。
 */
export function acquireSingleInstanceLock(lockPath: string, log: Logger, graceMs = 3000): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  let holder = readLock(lockPath);
  if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
    log.warn({ holderPid: holder.pid, lockPath }, "发现已有 donger 实例，等待其退出…");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      sleepSync(100);
      holder = readLock(lockPath);
      if (!holder || !isPidAlive(holder.pid)) break;
    }
    if (holder && isPidAlive(holder.pid)) {
      log.error(
        { holderPid: holder.pid, lockPath },
        "已有 donger 实例正在运行，本实例退出（如确需重启请先停止旧实例）",
      );
      process.exit(1);
    }
  }
  const own: LockContent = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(lockPath, JSON.stringify(own));
  process.on("exit", () => {
    try {
      const current = readLock(lockPath);
      if (current?.pid === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // 退出清理失败无需处理
    }
  });
}
