import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GateRouter } from "../domain/gate-router.js";
import type { RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";

/**
 * 真实 AgentRunner：用 Claude Agent SDK 的 query() 驱动。
 * 推理经 env.ANTHROPIC_BASE_URL 指向 GLM（Anthropic 兼容端点）；
 * superpowers 经 plugins + skills 加载；审批门经 canUseTool 接 GateRouter + resolver。
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly gates: GateRouter) {}

  async *run(task: Task, opts: RunOptions, resolver: ApprovalResolver): AsyncIterable<RunnerEvent> {
    const ac = new AbortController();
    opts.abortSignal?.addEventListener("abort", () => ac.abort(), { once: true });

    const stream = query({
      prompt: task.prompt,
      options: {
        cwd: opts.cwd,
        model: opts.llm.model,
        skills: opts.skills.length ? opts.skills : undefined,
        plugins: opts.pluginPaths?.map((path) => ({ type: "local" as const, path })),
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code",
          append: opts.systemPromptAppend ?? "",
        },
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool: async (toolName, input, ctx) => {
          const gated = this.gates.match(toolName, input);
          if (!gated) {
            return { behavior: "allow" as const, updatedInput: input, toolUseID: ctx.toolUseID };
          }
          const summary =
            toolName === "Bash" && typeof input.command === "string"
              ? String(input.command)
              : JSON.stringify(input).slice(0, 500);
          const decision = await resolver({
            taskId: task.id,
            gateId: gated.gateId,
            tool: toolName,
            toolUseId: ctx.toolUseID,
            input,
            summary,
          });
          return decision.approved
            ? { behavior: "allow" as const, updatedInput: input, toolUseID: ctx.toolUseID }
            : {
                behavior: "deny" as const,
                message: decision.reason ?? "审批未通过",
                toolUseID: ctx.toolUseID,
              };
        },
        abortController: ac,
        resume: opts.resume,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: opts.llm.baseUrl,
          ANTHROPIC_AUTH_TOKEN: opts.llm.authToken,
        },
      },
    });

    for await (const m of stream) {
      // DEBUG: 打印每条消息的类型和内容概要
      const preview = JSON.stringify(m).slice(0, 150);
      console.log("[runner] msg type:", m.type, "| preview:", preview);

      if (m.type === "system" && "subtype" in m && m.subtype === "init") {
        yield { type: "session_init", taskId: task.id, sessionId: m.session_id };
      } else if (m.type === "stream_event") {
        // 部分流式消息：提取增量文本
        const delta = (
          m as {
            type: "stream_event";
            message?: { content?: Array<{ type: string; text?: string }> };
          }
        ).message;
        if (delta?.content) {
          for (const block of delta.content) {
            if (block.type === "text" && block.text) {
              yield { type: "text", taskId: task.id, text: block.text };
            }
          }
        }
      } else if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text") {
            yield { type: "text", taskId: task.id, text: block.text };
          } else if (block.type === "tool_use") {
            yield {
              type: "tool_use",
              taskId: task.id,
              tool: block.name,
              input: block.input as Record<string, unknown>,
              toolUseId: block.id,
            };
          }
        }
      } else if (m.type === "result") {
        yield m.subtype === "success"
          ? {
              type: "result",
              taskId: task.id,
              subtype: "success",
              result: typeof m.result === "string" ? m.result : undefined,
            }
          : { type: "result", taskId: task.id, subtype: "error", error: "agent 执行出错" };
      }
    }
  }
}
