import type { RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";

export interface FakeGate {
  gateId: string;
  summary: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface FakeScript {
  /** 触发门前发的文本 */
  intro?: string;
  /** 命中的审批门（不设则不触发） */
  gate?: FakeGate;
  /** 审批通过后发的文本 */
  outro?: string;
  /** 成功结果文案 */
  result?: string;
}

/**
 * 脚本化 AgentRunner（M1 测试用，不依赖真实 SDK）。
 * 发 intro → 触发 gate（调 approvalResolver）→ deny 则 result error 终止；
 * approve 则发 outro + result success。
 */
export class FakeAgentRunner implements AgentRunner {
  constructor(private readonly script: FakeScript) {}

  async *run(
    task: Task,
    _opts: RunOptions,
    approvalResolver: ApprovalResolver,
  ): AsyncIterable<RunnerEvent> {
    if (this.script.intro) {
      yield { type: "text", taskId: task.id, text: this.script.intro };
    }

    if (this.script.gate) {
      const decision = await approvalResolver({
        taskId: task.id,
        gateId: this.script.gate.gateId,
        tool: this.script.gate.tool ?? "Bash",
        toolUseId: "tu-fake",
        input: this.script.gate.input ?? { command: "echo fake" },
        summary: this.script.gate.summary,
      });
      if (!decision.approved) {
        yield {
          type: "result",
          taskId: task.id,
          subtype: "error",
          error: decision.reason ?? "审批未通过",
        };
        return;
      }
    }

    if (this.script.outro) {
      yield { type: "text", taskId: task.id, text: this.script.outro };
    }
    yield {
      type: "result",
      taskId: task.id,
      subtype: "success",
      result: this.script.result ?? "done",
    };
  }
}
