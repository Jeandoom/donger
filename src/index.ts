// donger 应用入口：装配 Orchestrator + 真实适配器，按配置选通道。
// 有 DINGTALK_* → 钉钉 Stream；否则 → CLI（本地调试）。
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { CliChannel } from "./adapters/cli-channel.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { InMemoryTaskStore } from "./adapters/in-memory-task-store.js";
import { loadConfig } from "./config.js";
import { Planner } from "./domain/planner.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createWorktree } from "./util/git-worktree.js";
import { createLogger } from "./util/logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  const channelName = cfg.dingtalk ? "dingtalk" : "cli";
  log.info(
    { model: cfg.llm.model, channel: channelName, superpowers: !!cfg.superpowersPluginPath },
    "donger 启动",
  );

  const gates = createDefaultGates();
  const store = new InMemoryTaskStore();
  const runner = new ClaudeAgentRunner(gates);
  const channel = cfg.dingtalk ? new DingTalkChannel(cfg.dingtalk) : new CliChannel();

  const orch = new Orchestrator({
    store,
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (task, plan) => ({
      cwd: createWorktree(cfg.repoRoot, task.id),
      skills: plan.skills,
      pluginPaths: cfg.superpowersPluginPath ? [cfg.superpowersPluginPath] : [],
      llm: cfg.llm,
      systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
    }),
  });

  channel.onMessage((m) => {
    void orch.handleMessage(m);
  });

  log.info({ channel: channel.id }, "就绪");
}

void main();
