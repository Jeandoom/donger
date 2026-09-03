import { join } from "node:path";
import { type Agent, parseAgent } from "../domain/agent.js";
import { parseRoutingDecision, type RoutingDecision } from "../domain/routing.js";
import type { Conversation, Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";
import { RunnerError } from "../util/errors.js";
import type { RuntimeManager } from "./runtime-manager.js";

const DISPATCHER_SYSTEM_PROMPT = [
  "你是 donger 的任务分发器。唯一职责：把用户任务路由给最合适的执行智能体，不执行任务本身，不写任何文件。",
  "步骤：阅读知识库《任务管理知识库》下的 agents.md（执行智能体登记表）与 routing-rules.md（路由规则），",
  "对照用户任务选定唯一 agentId，并判定该任务是否需要方案设计人工确认（requiresDesign：涉及代码实现/架构变更/不熟悉的业务为 true；查询巡检/信息整理类为 false）。",
  "输出契约：最终回复必须以如下 JSON 结尾（可包在 ```json 代码块中），不得增删字段：",
  '{"agentId":"<登记表中的智能体 id>","requiresDesign":<true|false>,"taskType":"<任务分类标签>","rationale":"<一句话理由>"}',
  '知识库中无合适智能体时，agentId 填 "none" 并在 rationale 中说明能力缺口。',
].join("\n");

/** dispatcher 是系统内置 agent：代码内构造、不入库、不可在 UI 编辑（plan 偏差 1）。 */
export function buildDispatcherAgent(kbDir: string): Agent {
  return parseAgent({
    id: "builtin-dispatcher",
    ownerId: "system",
    name: "dispatcher",
    description: "系统任务分发器：阅读任务管理知识库，把任务路由给执行智能体",
    systemPrompt: DISPATCHER_SYSTEM_PROMPT,
    skills: ["task-dispatch"],
    tools: { mode: "whitelist", whitelist: ["Read", "Glob"] },
    mcpServers: [],
    gitRepositories: [],
    extensionDirectories: [
      {
        id: "kb-dispatcher",
        name: "任务管理知识库",
        path: join(kbDir, "dispatcher"),
        access: "readOnly",
      },
    ],
    llm: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

export interface DispatchParams {
  runner: AgentRunner;
  runtimeMgr: RuntimeManager;
  user: User;
  conversation: Conversation;
  prompt: string;
  kbDir: string;
  abortSignal?: AbortSignal;
}

/** 跑一次 dispatcher 轻量调用，返回结构化路由决策；失败抛 RunnerError("DISPATCH_FAILED")。 */
export async function dispatchTask(params: DispatchParams): Promise<RoutingDecision> {
  const dispatcher = buildDispatcherAgent(params.kbDir);
  // 复用 prepare 拿 llm/凭证/知识库目录注入；dispatcher 不接续用户会话
  const { runOptions } = await params.runtimeMgr.prepare(params.user, params.conversation, {
    agent: dispatcher,
    abortSignal: params.abortSignal,
  });
  const opts: RunOptions = {
    ...runOptions,
    skills: dispatcher.skills,
    resume: undefined,
    sessionStore: undefined,
  };
  // dispatcher 只有 Read/Glob 白名单，永不命中审批门；给一个兜底拒绝器
  const never: ApprovalResolver = async () => ({
    approved: false,
    reason: "dispatcher 无审批操作",
  });
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    channelId: "dispatch",
    threadId: "dispatch",
    requesterId: params.user.id,
    prompt: params.prompt,
    status: "running",
    skillChain: [],
    createdAt: now,
    updatedAt: now,
  };
  let output: string | undefined;
  for await (const e of params.runner.run(task, opts, never)) {
    if (e.type === "result") {
      if (e.subtype === "success") output = e.result;
      else throw new RunnerError("DISPATCH_FAILED", "任务分发失败：dispatcher 执行出错");
    }
  }
  if (!output) {
    throw new RunnerError("DISPATCH_FAILED", "任务分发失败：dispatcher 未返回结果");
  }
  try {
    return parseRoutingDecision(output);
  } catch (e) {
    throw new RunnerError("DISPATCH_FAILED", `任务分发失败：${(e as Error).message}`, e);
  }
}
