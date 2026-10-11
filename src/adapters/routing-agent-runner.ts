import type { LlmSdkType } from "../domain/llm-platforms.js";
import type { RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";

/**
 * 按 llm.sdkType 路由执行引擎（specs/2026-09-21-codex-openai-runner-design.md §6、
 * specs/2026-09-25-zcode-engine-integration.md §4.1）：
 * anthropic（缺省，向后兼容存量构造）→ ClaudeAgentRunner；openai → CodexAgentRunner；
 * zcode → ZcodeAgentRunner（GLM 官方 harness）。
 * isAwaitingUserInput 向 claude / zcode 两侧透传（两者都有问询桥）；codex 恒 false。
 *
 * engineGate（M1 引擎插件启停门禁，specs/2026-10-11-plugin-system-design.md §1.3）：
 * 返回 false 的 sdkType 轮 fail-closed 显性失败（不静默换引擎，错误归入不可恢复分类，
 * 不清会话模型指针只提示）；未注入 gate 时全部放行（向后兼容存量构造/测试）。
 */
export class RoutingAgentRunner implements AgentRunner {
  constructor(
    private readonly anthropic: AgentRunner,
    private readonly openai: AgentRunner,
    private readonly zcode: AgentRunner,
    private readonly engineGate?: (sdkType: LlmSdkType) => boolean,
  ) {}

  run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    const sdkType = opts.llm.sdkType;
    if (this.engineGate && !this.engineGate(sdkType ?? "anthropic")) {
      throw new Error(
        `执行引擎已停用（${sdkType ?? "anthropic"}）：本会话所选模型指向已停用的引擎，` +
          `请在该会话切换其他模型，或由管理员在插件页重新启用该引擎`,
      );
    }
    return this.pick(sdkType).run(task, opts, resolver);
  }

  isAwaitingUserInput(taskId: string): boolean {
    return (
      this.anthropic.isAwaitingUserInput?.(taskId) === true ||
      this.zcode.isAwaitingUserInput?.(taskId) === true
    );
  }

  private pick(sdkType: LlmSdkType | undefined): AgentRunner {
    if (sdkType === "openai") return this.openai;
    if (sdkType === "zcode") return this.zcode;
    return this.anthropic;
  }
}
