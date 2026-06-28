// 冒烟脚本：用真实 GLM 跑一次 ClaudeAgentRunner，验证 SDK + GLM + 事件归一连通。
// 用法：LLM_MODEL=GLM-5.2 npx tsx scripts/smoke.ts   （ANTHROPIC_* 走进程 env 继承）
// 可选：SMOKE_PROMPT="..." SUPERPOWERS_PLUGIN_PATH=... 启用 superpowers。
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentRunner } from "../src/adapters/claude-agent-runner.js";
import { createDefaultGates } from "../src/orchestrator/default-gates.js";
import { loadConfig } from "../src/config.js";
import type { RunnerEvent, Task } from "../src/domain/types.js";
import { createWorktree } from "../src/util/git-worktree.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  console.log("[smoke] model=", cfg.llm.model, "baseUrl=", cfg.llm.baseUrl);
  console.log("[smoke] superpowers=", cfg.superpowersPluginPath ?? "(未启用)");

  // 临时 git 仓库 + worktree（不碰真实代码）
  const repo = mkdtempSync(join(tmpdir(), "donger-smoke-"));
  try {
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
    writeFileSync(join(repo, "hello.js"), "console.log('hi');\n");
    execSync('git add . && git commit -qm init', { cwd: repo });
    const wt = createWorktree(repo, "smoke-task");
    console.log("[smoke] worktree=", wt);

    const runner = new ClaudeAgentRunner(createDefaultGates());
    const task: Task = {
      id: crypto.randomUUID(),
      channelId: "smoke",
      threadId: "smoke",
      requesterId: "local",
      prompt: process.env.SMOKE_PROMPT ?? "请直接回复 pong 两个字，不要做任何其他事。",
      status: "running",
      skillChain: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const opts = {
      cwd: wt,
      skills: cfg.superpowersPluginPath ? ["superpowers:brainstorming"] : [],
      pluginPaths: cfg.superpowersPluginPath ? [cfg.superpowersPluginPath] : [],
      llm: cfg.llm,
    };

    console.log("[smoke] 运行中…");
    let lastResult: RunnerEvent | undefined;
    for await (const e of runner.run(task, opts, async (req) => {
      console.log("[smoke] 审批门(自动通过):", req.gateId);
      return { approved: true };
    })) {
      if (e.type === "session_init") console.log("[session]", e.sessionId);
      else if (e.type === "text") console.log("[agent]", e.text);
      else if (e.type === "tool_use") console.log("[tool]", e.tool, JSON.stringify(e.input).slice(0, 80));
      else if (e.type === "result") {
        lastResult = e;
        console.log("[result]", e.subtype, e.result ?? e.error);
      }
    }

    const ok = lastResult?.type === "result" && lastResult.subtype === "success";
    console.log("[smoke] 结论:", ok ? "✅ 成功" : "❌ 失败");
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

void main();
