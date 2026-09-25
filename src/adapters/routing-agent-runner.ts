import type { LlmSdkType } from "../domain/llm-platforms.js";
import type { RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";

/**
 * 按 llm.sdkType 路由执行引擎（specs/2026-09-21-codex-openai-runner-design.md §6、
 * specs/2026-09-25-zcode-engine-integration.md §4.1）：
 * anthropic（缺省，向后兼容存量构造）→ ClaudeAgentRunner；openai → CodexAgentRunner；
 * zcode → ZcodeAgentRunner（GLM 官方 harness）。
 * isAwaitingUserInput 向 claude / zcode 两侧透传（两者都有问询桥）；codex 恒 false。
 */
export class RoutingAgentRunner implements AgentRunner {
  constructor(
    private readonly anthropic: AgentRunner,
    private readonly openai: AgentRunner,
    private readonly zcode: AgentRunner,
  ) {}

  run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    return this.pick(opts.llm.sdkType).run(task, opts, resolver);
  }

  isAwaitingUserInput(taskId: string): boolean {
    return this.anthropic.isAwaitingUserInput?.(taskId) === true
      || this.zcode.isAwaitingUserInput?.(taskId) === true;
  }

  private pick(sdkType: LlmSdkType | undefined): AgentRunner {
    if (sdkType === "openai") return this.openai;
    if (sdkType === "zcode") return this.zcode;
    return this.anthropic;
  }
}
