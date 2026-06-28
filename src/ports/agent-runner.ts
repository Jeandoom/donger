import type { LLMConfig } from "../domain/llm-config.js";
import type { ApprovalDecision, ApprovalRequest, RunnerEvent, Task } from "../domain/types.js";

/** 运行一个任务所需的环境（由编排层从 LLMConfig + 任务上下文注入） */
export interface RunOptions {
  cwd: string;
  skills: string[];
  /** 要加载的插件路径（runner 转成 SDK 的 [{type:"local",path}]） */
  pluginPaths?: string[];
  llm: LLMConfig;
  systemPromptAppend?: string;
  abortSignal?: AbortSignal;
}

/** runner 命中审批门时回调；由 Orchestrator 实现（推卡 → 等用户 → 返回决议） */
export type ApprovalResolver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** 执行引擎端口：消费任务，产出事件流，门内调用 approvalResolver */
export interface AgentRunner {
  run(task: Task, opts: RunOptions, approvalResolver: ApprovalResolver): AsyncIterable<RunnerEvent>;
}
