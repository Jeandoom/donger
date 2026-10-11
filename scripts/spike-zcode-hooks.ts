// M1.5 实验：zcode workspace hooks 配置形态探测。
// 在 workspace 写猜测形态的 hooks 配置（Claude Code settings 同构），spawn app-server
// 跑一条消息，抓 CLI 发来的全部协议消息（review 请求？hook 执行？报错？）。
// 用法：npx tsx scripts/spike-zcode-hooks.ts
import "dotenv/config";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  defaultZcodeConnectionFactory,
  type ZcodeConnection,
} from "../src/adapters/zcode-protocol-client.js";
import {
  resolveBuiltinProviderConfig,
  resolveCliPath,
  writeProviderConfig,
} from "../src/adapters/zcode-agent-runner.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const workspace = mkdtempSync(join(tmpdir(), "donger-zhooks-"));
  const homeDir = join(workspace, "users", "probe");
  const dataDir = join(workspace, "data");
  const runtimeHome = join(homeDir, ".zcode-home");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // hooks 配置（bundle 实测 schema：{enabled, events: {<事件>: [{matcher, hooks:[...]}]}}）
  // 本轮：hook 把 stdin 落盘（抓工具调用载荷形态）+ 非零退出码（验证拒绝语义）
  const stdinDump = join(workspace, "hook-stdin-dump.txt");
  const hooksConfig = {
    hooks: {
      enabled: true,
      timeoutMs: 15000,
      maxOutputBytes: 32768,
      events: {
        PreToolUse: [
          {
            matcher: "Bash|Read",
            hooks: [
              {
                type: "command",
                command: `cmd /c more > "${stdinDump}" & exit /b 2`,
              },
            ],
          },
        ],
      },
    },
  };
  writeFileSync(join(workspace, "zcode.json"), JSON.stringify(hooksConfig, null, 2));
  // 用户级：HOME 重定向下的 zcode 用户配置（nativeConfigDir=".zcode/cli"）
  const userConfigDir = join(homeDir, ".zcode", "cli");
  mkdirSync(userConfigDir, { recursive: true });
  writeFileSync(join(userConfigDir, "config.json"), JSON.stringify(hooksConfig, null, 2));
  log(`hooks 配置（enabled+events 形态）已写 workspace zcode.json + 用户级 config.json`);

  // provider 配置物化（GLM key）
  const providerConfigPath = join(dataDir, ".zcode", "v2", "provider_config.json");
  mkdirSync(join(dataDir, ".zcode", "v2"), { recursive: true });
  writeProviderConfig(providerConfigPath, cfg.llm);
  const cliPath = resolveCliPath();
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    HOME: homeDir,
    USERPROFILE: homeDir,
    ZCODE_DATA_BASE_DIR: dataDir,
    ZCODE_SESSION_DB_PATH: join(runtimeHome, "db.sqlite"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: resolveBuiltinProviderConfig(cliPath),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfigPath,
    ZCODE_NO_BROWSER: "1",
  };

  const conn: ZcodeConnection = await defaultZcodeConnectionFactory(
    {
      cwd: workspace,
      cliPath,
      env,
    },
    {
      onRequest: (method, params) => {
        log(`◀ 反向请求 ${method}: ${JSON.stringify(params).slice(0, 300)}`);
        if (method === "interaction/requestPermission") {
          return { decision: "allow" };
        }
        if (method === "session/requestRuntimePreferences") {
          // 照 zcode-agent-runner.handleRuntimePreferences 形状（Zod 校验须全 boolean 字段）
          return {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          };
        }
        return {};
      },
      onNotification: (n) => {
        log(`◀ 通知 ${n.method}: ${JSON.stringify(n.params).slice(0, 200)}`);
      },
      onSessionEvent: (e) => {
        log(`◀ session/event ${JSON.stringify(e).slice(0, 220)}`);
      },
      onStderr: (chunk) => {
        const s = chunk.toString().trim();
        if (s) log(`[stderr] ${s.slice(0, 200)}`);
      },
    },
  );

  try {
    const created = await conn.request<{ session?: { sessionId?: string } }>("session/create", {
      workspace: { workspacePath: workspace, workspaceKey: workspace },
      mode: "build",
    });
    const sessionId = created.session?.sessionId ?? "";
    log(`session/create → ${sessionId || "(空)"}`);
    await conn.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
    });
    // runtime/capabilities 声明（试宿主能否借此声明 hooks 支持）
    conn.notify("runtime/capabilities", { hooks: true, workspaceHooks: true });
    log("已发 runtime/capabilities {hooks:true}");
    await conn.request("session/send", {
      sessionId,
      content: "运行命令 echo hello 并告诉我输出",
    });
    log("session/send 已发，观察 45s…");
    await new Promise((r) => setTimeout(r, 45_000));
    if (existsSync(stdinDump)) {
      log(`hook stdin 载荷: ${readFileSync(stdinDump, "utf8").slice(0, 400)}`);
    } else {
      log("hook stdin 未落盘（hook 可能未收到 stdin）");
    }
  } finally {
    try {
      (conn as { close?: () => void }).close?.();
    } catch {}
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error("spike 失败:", e);
  process.exit(1);
});
