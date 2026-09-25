import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZcodeAgentRunner } from "../../src/adapters/zcode-agent-runner.js";
import type { GateRouter } from "../../src/domain/gate-router.js";
import type { RunnerEvent, Task } from "../../src/domain/types.js";
import type { RunOptions } from "../../src/ports/agent-runner.js";

// 真机冒烟：spawn 真实 zcode app-server + 假 key——预期走到模型请求层失败
// （turn.failed → result error），验证协议/守卫/事件泵全链路。
// 依赖本机 ZCode CLI（无 CLI 环境自动跳过；生产机随 ZCode 引擎启用而具备）。
const cliAvailable = resolveCliPathQuiet() !== null;

function resolveCliPathQuiet(): string | null {
  const configured = process.env.DONGER_ZCODE_CLI_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    "C:/Program Files/ZCode/resources/glm/zcode.cjs",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe.skipIf(!cliAvailable)("ZcodeAgentRunner 真机冒烟", () => {
  it("真实 app-server：假 key 走到模型请求层并显性报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-smoke-"));
    const gates = { match: () => undefined } as unknown as GateRouter;
    const runner = new ZcodeAgentRunner(gates);
    const task: Task = {
      id: "t-smoke",
      channelId: "web",
      threadId: "c",
      requesterId: "u",
      prompt: "Reply with one word: pong",
      status: "running",
      skillChain: [],
      createdAt: "t",
      updatedAt: "t",
    };
    const opts: RunOptions = {
      cwd: dir,
      skills: [],
      llm: {
        model: "glm-4.6",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        authToken: "donger-smoke-fake-key",
        sdkType: "zcode",
      },
      workspaceRoot: dir,
      allowedTools: ["Read", "Glob"],
    };
    const events: RunnerEvent[] = [];
    for await (const e of runner.run(task, opts, async () => ({ approved: true }))) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    console.log("[SMOKE] events:", types.join(","));
    const result = events[events.length - 1] as Extract<RunnerEvent, { type: "result" }>;
    expect(result.subtype).toBe("error");
    // 关键断言：错误发生在 provider/模型请求层（而非会话建立/白名单层）
    expect(
      /provider|model|request|认证|api|配置|signing|credential/i.test(result.error ?? ""),
    ).toBe(true);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放延迟：临时目录残留无害（OS Temp 会清理）
    }
  }, 120_000);
});
