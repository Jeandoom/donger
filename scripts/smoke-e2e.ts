// 全链路 e2e 冒烟：Orchestrator + 真实 GLM(ClaudeAgentRunner) + worktree + 内存 channel。
// 类似 T1.11 纵切测试，但用真实 GLM 替换 Fake runner。验证「消息→规划→GLM 执行工具→结果」全链路。
// 用法：LLM_MODEL=GLM-5.2 npx tsx scripts/smoke-e2e.ts
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentRunner } from "../src/adapters/claude-agent-runner.js";
import { InMemoryTaskStore } from "../src/adapters/in-memory-task-store.js";
import { loadConfig } from "../src/config.js";
import { Planner } from "../src/domain/planner.js";
import { createDefaultGates } from "../src/orchestrator/default-gates.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { Channel } from "../src/ports/channel.js";
import { createWorktree } from "../src/util/git-worktree.js";

function captureChannel(): { ch: Channel; sent: string[] } {
  const sent: string[] = [];
  const ch: Channel = {
    id: "smoke",
    onMessage: () => {},
    send: async (_t, m) => {
      sent.push(m.text);
      console.log("[out]", m.text);
    },
    requestApproval: async (_t, c) => {
      console.log("[approval]", c.title, "→ 自动通过");
      return { approved: true };
    },
  };
  return { ch, sent };
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  console.log("[smoke-e2e] model=", cfg.llm.model);

  // 临时 git 仓库作为 REPO_ROOT
  const repo = mkdtempSync(join(tmpdir(), "donger-e2e-"));
  try {
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "donger-e2e-secret-123\n");
    execSync("git add . && git commit -qm init", { cwd: repo });

    const gates = createDefaultGates();
    const { ch, sent } = captureChannel();
    const orch = new Orchestrator({
      store: new InMemoryTaskStore(),
      planner: new Planner(),
      gates,
      runner: new ClaudeAgentRunner(gates),
      channel: ch,
      // smoke 用空技能 + 无 superpowers，避免对 trivial 任务跑重流程（brainstorm→TDD）
      runOptsFor: async (task) => ({
        cwd: createWorktree(repo, task.id),
        skills: [],
        pluginPaths: [],
        llm: cfg.llm,
      }),
    });

    console.log("[smoke-e2e] 发送任务…");
    await orch.handleMessage({
      channelId: "smoke",
      threadId: "t1",
      requesterId: "u",
      text: "在当前目录实现一个 hello.js 文件，内容为 console.log('hi')",
    });

    const ok = sent.some((t) => t.includes("✅ 完成"));
    console.log("[smoke-e2e] 结论:", ok ? "✅ 全链路成功" : "❌ 失败");
    console.log("[smoke-e2e] 输出:", sent.join(" | ").slice(0, 200));
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

void main();
