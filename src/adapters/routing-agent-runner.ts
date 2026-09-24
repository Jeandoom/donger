import type { LlmSdkType } from "../domain/llm-platforms.js";
import type { RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";

/**
 * 按 llm.sdkType 路由执行引擎（specs/2026-09-21-codex-openai-runner-design.md §6）：
 * anthropic（缺省，向后兼容存量构造）→ ClaudeAgentRunner；openai → CodexAgentRunner。
 * isAwaitingUserInput 仅向 claude 侧透传（codex 无问询通道，其 runner 恒 false）。
 */
export class RoutingAgentRunner implements AgentRunner {
  constructor(
    private readonly anthropic: AgentRunner,
    private readonly openai: AgentRunner,
  ) {}

  run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    const runner = this.pick(opts.llm.sdkType);
    return runner.run(task, opts, resolver);
  }

  isAwaitingUserInput(taskId: string): boolean {
    return this.anthropic.isAwaitingUserInput?.(taskId) ?? false;
  }

  private pick(sdkType: LlmSdkType | undefined): AgentRunner {
    return sdkType === "openai" ? this.openai : this.anthropic;
  }
}
