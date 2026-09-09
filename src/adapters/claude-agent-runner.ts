import { isAbsolute, resolve, sep } from "node:path";
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "../domain/agent.js";
import type { GateRouter } from "../domain/gate-router.js";
import type { RunnerEvent, Task, TokenUsage } from "../domain/types.js";
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

    const mcpServersSdk: Record<string, SdkMcpServerConfig> = {
      ...(opts.mcpServers?.length ? mcpServersToSdk(opts.mcpServers) : {}),
      ...(opts.platformTools ? { "donger-platform": opts.platformTools } : {}),
      ...(opts.gitPlatformTools ? { "donger-git": opts.gitPlatformTools } : {}),
    };

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
        includePartialMessages: true,
        ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
        ...(Object.keys(mcpServersSdk).length ? { mcpServers: mcpServersSdk } : {}),
        ...(opts.additionalDirectories?.length
          ? { additionalDirectories: opts.additionalDirectories }
          : {}),
        settingSources: ["project"],
        sandbox: {
          enabled: true,
          failIfUnavailable: false,
          allowUnsandboxedCommands: true,
          ...(opts.readOnlyRoots?.length ? { filesystem: { denyWrite: opts.readOnlyRoots } } : {}),
        },
        permissionMode: "default",
        canUseTool: async (toolName, input, ctx) => {
          // 工具白名单强制：allowedTools 之外的工具一律 deny。
          // SDK 的 allowedTools 只约束自动允许集合，未列出的工具会落到本回调——
          // 不在此处拦截的话，白名单形同虚设（曾导致只读 dispatcher 放行 Bash）。
          if (opts.allowedTools && !opts.allowedTools.includes(toolName)) {
            return {
              behavior: "deny" as const,
              message: `工具 ${toolName} 不在该智能体的允许列表内（allowedTools）`,
              toolUseID: ctx.toolUseID,
            };
          }
          const writeRoots = [
            ...(opts.workspaceRoot ? [resolve(opts.workspaceRoot)] : []),
            ...(opts.allowedWriteRoots ?? []).map((root) => resolve(root)),
          ];
          // 写入边界：direct write tools 必须落在用户工作区或显式读写扩展目录内
          if (
            writeRoots.length > 0 &&
            (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")
          ) {
            const rawPath =
              typeof input.file_path === "string"
                ? input.file_path
                : typeof input.notebook_path === "string"
                  ? input.notebook_path
                  : null;
            if (rawPath) {
              const abs = isAbsolute(rawPath) ? rawPath : resolve(opts.cwd, rawPath);
              const deniedByReadOnly = (opts.readOnlyRoots ?? [])
                .map((root) => resolve(root))
                .some((root) => abs.startsWith(root + sep) || abs === root);
              if (deniedByReadOnly) {
                return {
                  behavior: "deny" as const,
                  message: `写入越界：${rawPath} 位于只读扩展目录内`,
                  toolUseID: ctx.toolUseID,
                };
              }
              if (!writeRoots.some((root) => abs.startsWith(root + sep) || abs === root)) {
                return {
                  behavior: "deny" as const,
                  message: `写入越界：${rawPath} 不在允许的写入目录内`,
                  toolUseID: ctx.toolUseID,
                };
              }
            }
          }
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
        sessionStore: opts.sessionStore,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: opts.llm.baseUrl,
          ANTHROPIC_AUTH_TOKEN: opts.llm.authToken,
          ...opts.credentialsEnv,
        },
      },
    });

    yield {
      type: "llm_input",
      taskId: task.id,
      input: serializeJson({
        prompt: task.prompt,
        options: {
          cwd: opts.cwd,
          model: opts.llm.model,
          skills: opts.skills,
          plugins: opts.pluginPaths?.map((path) => ({ type: "local", path })),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: opts.systemPromptAppend ?? "",
          },
          includePartialMessages: true,
          allowedTools: opts.allowedTools,
          mcpServers: opts.mcpServers,
          platformTools: opts.platformTools ? "donger-platform" : undefined,
          additionalDirectories: opts.additionalDirectories,
          settingSources: ["project"],
          sandbox: {
            enabled: true,
            failIfUnavailable: false,
            allowUnsandboxedCommands: true,
            filesystem: opts.readOnlyRoots?.length ? { denyWrite: opts.readOnlyRoots } : undefined,
          },
          permissionMode: "default",
          resume: opts.resume,
          workspaceRoot: opts.workspaceRoot,
          allowedWriteRoots: opts.allowedWriteRoots,
          readOnlyRoots: opts.readOnlyRoots,
          capabilityVersion: opts.capabilityVersion,
          credentialKeys: Object.keys(opts.credentialsEnv ?? {}),
        },
      }),
    };

    let streamingMessageId: string | null = null;
    for await (const m of stream) {
      if (m.type === "system" && "subtype" in m && m.subtype === "init") {
        yield { type: "session_init", taskId: task.id, sessionId: m.session_id };
      } else if (m.type === "stream_event") {
        if (m.event.type === "message_start") {
          streamingMessageId = m.event.message.id;
        } else if (
          m.event.type === "content_block_delta" &&
          m.event.delta.type === "text_delta" &&
          streamingMessageId
        ) {
          yield {
            type: "text_delta",
            taskId: task.id,
            messageId: streamingMessageId,
            text: m.event.delta.text,
          };
        } else if (m.event.type === "content_block_delta" && streamingMessageId) {
          // GLM/Claude 思考流：thinking_delta（signature_delta 等其余变体忽略）
          const delta = m.event.delta as { type?: string; thinking?: string };
          if (delta.type === "thinking_delta" && delta.thinking) {
            yield {
              type: "thinking_delta",
              taskId: task.id,
              messageId: streamingMessageId,
              text: delta.thinking,
            };
          }
        } else if (m.event.type === "message_stop") {
          streamingMessageId = null;
        }
      } else if (m.type === "assistant") {
        yield { type: "llm_output", taskId: task.id, output: serializeJson(m) };
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
      } else if (m.type === "user") {
        yield { type: "llm_input", taskId: task.id, input: serializeJson(m) };
        const content =
          (
            m as {
              message?: {
                content?: Array<{
                  type: string;
                  tool_use_id?: string;
                  content?: unknown;
                  is_error?: boolean;
                }>;
              };
            }
          ).message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const raw = block.content;
            const text = typeof raw === "string" ? raw : JSON.stringify(raw);
            yield {
              type: "tool_result",
              taskId: task.id,
              toolUseId: block.tool_use_id ?? "",
              content: text,
              isError: block.is_error === true,
            };
          }
        }
      } else if (m.type === "result") {
        const raw = (
          m as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
            errors?: string[];
          }
        ).usage;
        const usage: TokenUsage | undefined = raw
          ? {
              inputTokens: raw.input_tokens ?? 0,
              outputTokens: raw.output_tokens ?? 0,
              cacheCreationInputTokens: raw.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
            }
          : undefined;
        if (m.subtype === "success") {
          yield {
            type: "result",
            taskId: task.id,
            subtype: "success",
            result: typeof m.result === "string" ? m.result : undefined,
            usage,
          };
        } else {
          // 透传 SDK 原始错误（errors[]，如 "No conversation found with session ID"）：
          // 上层 session 过期重试靠该文本匹配触发；包装文案会让自愈机制失效且不可诊断
          const sdkMsg = (m as { errors?: string[] }).errors;
          const detail = Array.isArray(sdkMsg)
            ? sdkMsg.filter((e) => typeof e === "string" && e).join("; ")
            : "";
          yield {
            type: "result",
            taskId: task.id,
            subtype: "error",
            error: detail || "agent 执行出错",
            usage,
          };
        }
      }
    }
  }
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把 donger 的 McpServerConfig[] 映射为 SDK 的 Record<string, McpServerConfig> */
function mcpServersToSdk(servers: McpServerConfig[]): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const s of servers) {
    out[s.name] =
      s.type === "stdio"
        ? ({
            type: "stdio",
            command: s.command,
            args: s.args ?? [],
            env: s.env,
          } as SdkMcpServerConfig)
        : ({ type: "http", url: s.url, headers: s.headers } as SdkMcpServerConfig);
  }
  return out;
}
