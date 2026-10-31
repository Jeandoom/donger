#!/usr/bin/env node
// donger release-agent（spec docs/superpowers/specs/2026-10-20-release-webhook-design.md §5.3）
// 职责：常驻触发层——消费 app 投递的唤醒文件 + POLL_SECONDS 兜底轮询，二者收敛到同一次
// `bash host-release-watcher.sh --once`。部署决策仍在管线脚本内（fetch origin/master 与
// 状态文件比对），本进程只提供「触发」与「防卡死硬顶」，不做任何部署判断。
// 并发互斥不自建：管线内 mkdir 锁天然跨调用串行（唤醒撞执行=锁跳过）。
// 硬顶补丁：--once 形态的孤儿锁自愈依赖「下一轮」发现；常驻形态 run_once 卡死就没有
// 下一轮，故 spawn 带 ONCE_TIMEOUT 硬顶 kill，kill 后由既有锁龄>30min 自愈接管。
// 例行化（管理员 PowerShell 一次）：D:\deploy\donger-docker\install-release-agent.ps1
// 配置（环境变量均可缺省）：RELEASE_AGENT_REPO/STACK/WAKE_DIR/LOG/POLL_SECONDS/ONCE_TIMEOUT_MS/BASH
import { spawn } from "node:child_process";
import { closeSync, openSync, watch } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ONCE = process.argv.includes("--once");

const REPO = process.env.RELEASE_AGENT_REPO ?? "D:\\code\\donger";
const STACK = process.env.RELEASE_AGENT_STACK ?? "D:\\deploy\\donger-docker";
const WAKE_DIR = process.env.RELEASE_AGENT_WAKE_DIR ?? path.join(STACK, "release-wake");
const LOG_FILE = process.env.RELEASE_AGENT_LOG ?? path.join(REPO, "logs", "release-watcher.log");
const POLL_SECONDS = Number(process.env.RELEASE_AGENT_POLL_SECONDS ?? 300);
const ONCE_TIMEOUT_MS = Number(process.env.RELEASE_AGENT_ONCE_TIMEOUT_MS ?? 30 * 60 * 1000);
const BASH = process.env.RELEASE_AGENT_BASH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
// 唤醒残留 TTL：agent 长期未运行时目录里会堆遗留唤醒文件，超期直接清（轮询早已对账过）
const WAKE_TTL_MS = 24 * 60 * 60 * 1000;

const SELF_PATH = fileURLToPath(import.meta.url);
let selfMtimeMs = 0;
let selfMtimeWarned = false;

async function log(line) {
  const stamped = `[release-agent ${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    await appendFile(LOG_FILE, stamped + "\n");
  } catch {
    // 日志不可写不阻断触发（管线自身还有 release-<sha>.log 取证）
  }
}

function executeOnce(trigger) {
  return new Promise((resolve) => {
    const started = Date.now();
    let fd;
    try {
      // 管线 stdout/stderr 落同一份 release-watcher.log（旧 cmd 包装的重定向由这里接管）
      fd = openSync(LOG_FILE, "a");
    } catch {
      fd = undefined;
    }
    const child = spawn(BASH, ["scripts/host-release-watcher.sh", "--once"], {
      cwd: REPO,
      windowsHide: true,
      stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      void log(`execute 超硬顶 ${ONCE_TIMEOUT_MS}ms，kill（孤儿锁交由锁龄自愈接管）`);
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }, ONCE_TIMEOUT_MS);
    child.on("error", async (err) => {
      clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
      await log(`!! execute spawn 失败 trigger=${trigger}: ${err.message}`);
      resolve();
    });
    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
      const secs = Math.round((Date.now() - started) / 1000);
      await log(
        `execute 完成 trigger=${trigger} rc=${code}${killed ? "（硬顶kill）" : ""} 耗时=${secs}s`,
      );
      resolve();
    });
  });
}

// 触发队列：同名单去重（轮询撞唤醒=只跑一次），严格串行（管线内锁再兜一层）
const queue = [];
let running = false;
function enqueue(trigger) {
  if (queue.includes(trigger)) return;
  queue.push(trigger);
  void pump();
}
async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) await executeOnce(queue.shift());
  } finally {
    running = false;
  }
}

// 先消费后执行：执行崩溃也不重放该文件（轮询兜底对账）
async function consumeWakeFile(file) {
  const full = path.join(WAKE_DIR, file);
  let provider = "unknown";
  try {
    provider = JSON.parse(await readFile(full, "utf8")).provider ?? provider;
  } catch {
    // 内容损坏不阻断——文件只承载唤醒信号
  }
  try {
    await unlink(full);
  } catch {
    return; // 被并发消费
  }
  await log(`wake 文件已消费 provider=${provider}`);
  enqueue(`wake:${provider}`);
}

async function scanWakeDir() {
  let entries;
  try {
    entries = await readdir(WAKE_DIR);
  } catch {
    return;
  }
  for (const file of entries) {
    if (!file.startsWith("wake-")) continue;
    try {
      const s = await stat(path.join(WAKE_DIR, file));
      if (Date.now() - s.mtimeMs > WAKE_TTL_MS) {
        await unlink(path.join(WAKE_DIR, file));
        await log(`清理超期唤醒残留 ${file}`);
        continue;
      }
    } catch {
      continue;
    }
    await consumeWakeFile(file);
  }
}

let scanTimer;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void scanWakeDir(), 200);
}
function startWatching() {
  try {
    const watcher = watch(WAKE_DIR, { persistent: true }, scheduleScan);
    watcher.on("error", () => {
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
      setTimeout(startWatching, 5000);
    });
  } catch {
    setTimeout(startWatching, 5000);
  }
}

// 自更新提醒：agent 代码随发布更新但常驻进程不换血，打日志提示重启
async function checkSelfUpdate() {
  if (selfMtimeWarned) return;
  try {
    const s = await stat(SELF_PATH);
    if (selfMtimeMs && s.mtimeMs !== selfMtimeMs) {
      selfMtimeWarned = true;
      await log("!! agent 代码文件已更新，进程仍在跑旧代码——重启 donger-release-agent 任务换血");
    }
    selfMtimeMs = s.mtimeMs;
  } catch {
    // 自身 stat 失败不阻断
  }
}

async function main() {
  await mkdir(WAKE_DIR, { recursive: true });
  try {
    selfMtimeMs = (await stat(SELF_PATH)).mtimeMs;
  } catch {
    // 打包形态无自身文件
  }
  await log(
    `agent 启动 mode=${ONCE ? "once" : "daemon"} repo=${REPO} wakeDir=${WAKE_DIR} poll=${POLL_SECONDS}s timeout=${ONCE_TIMEOUT_MS}ms`,
  );
  await scanWakeDir();
  if (ONCE) {
    enqueue("poll-once");
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (!running && queue.length === 0) {
          clearInterval(t);
          resolve();
        }
      }, 100);
    });
    await log("once 模式结束");
    return;
  }
  startWatching();
  setInterval(() => {
    void checkSelfUpdate();
    enqueue("poll");
  }, POLL_SECONDS * 1000);
  enqueue("poll-startup"); // 启动即对账一次，拉平停机窗口
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    void log(`agent 收到 ${sig} 退出`);
    process.exit(0);
  });
}
process.on("uncaughtException", (err) => {
  void log(`!! uncaughtException: ${err?.stack ?? err}`);
  process.exit(1); // fail-closed，交给任务重启策略拉活
});
process.on("unhandledRejection", (err) => {
  void log(`!! unhandledRejection: ${err?.stack ?? err}`);
  process.exit(1);
});

main().catch(async (err) => {
  await log(`!! agent 启动失败: ${err?.stack ?? err}`);
  process.exit(1);
});
