import { delimiter, isAbsolute, resolve, sep } from "node:path";
import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "../domain/agent.js";
import type { GateRouter } from "../domain/gate-router.js";
import { matchesShellGit } from "../domain/git-shell-guard.js";
import { isReadOnlyShellCommand } from "../domain/read-only-shell-command.js";
import type { RunnerEvent, Task, TokenUsage } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";
import { BUILTIN_TOOL_TEXT_PREFIX } from "../util/provider-tool-text.js";

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
      ...(opts.kbTools ? { "donger-kb": opts.kbTools } : {}),
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
          // shell git 守卫（收口防线 2）：所有会话默认禁止 Bash 直跑 git（含 CLI/闲聊），
          // 引导用 donger-git 工具；gitAllowShellGit=true（agent 显式逃生门）才放行。
          if (
            toolName === "Bash" &&
            opts.gitAllowShellGit !== true &&
            typeof input.command === "string" &&
            matchesShellGit(input.command)
          ) {
            return {
              behavior: "deny" as const,
              message:
                "git 操作请使用 donger-git 工具（git_clone/git_pull/git_push 等）。如确需 shell git，请在智能体配置中开启「允许 shell git」。",
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
          // 只读命令豁免审批门：deploy 门关键词会把 git fetch / 平台 API GET 误拦为
          // 部署/发布（60s 审批超时即任务失败），且诱导 agent 拆分字符串绕过（P2-9）
          if (
            toolName === "Bash" &&
            typeof input.command === "string" &&
            isReadOnlyShellCommand(input.command)
          ) {
            return { behavior: "allow" as const, updatedInput: input, toolUseID: ctx.toolUseID };
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
          // 插件共享运行库桥：技能脚本 `from credentials import ...` 等共享包导入依赖
          ...(opts.pythonPaths?.length
            ? {
                PYTHONPATH: [
                  ...opts.pythonPaths,
                  ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : []),
                ].join(delimiter),
              }
            : {}),
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
    // 内置工具协议块拦截：按 content block 缓冲首个增量判定 "**🌐" 前缀，命中则吞掉
    // 该块全部增量（完整 text 事件仍会产出，由事件桥折叠），避免协议噪声/预签名 URL 直出前端
    const blockPrefixBuffers = new Map<number, string>();
    const suppressedBlocks = new Set<number>();
    for await (const m of stream) {
      if (m.type === "system" && "subtype" in m && m.subtype === "init") {
        yield { type: "session_init", taskId: task.id, sessionId: m.session_id };
      } else if (m.type === "stream_event") {
        if (m.event.type === "message_start") {
          streamingMessageId = m.event.message.id;
          blockPrefixBuffers.clear();
          suppressedBlocks.clear();
        } else if (
          m.event.type === "content_block_delta" &&
          m.event.delta.type === "text_delta" &&
          streamingMessageId
        ) {
          const blockIndex = typeof m.event.index === "number" ? m.event.index : 0;
          if (suppressedBlocks.has(blockIndex)) continue;
          const buffered = (blockPrefixBuffers.get(blockIndex) ?? "") + m.event.delta.text;
          blockPrefixBuffers.delete(blockIndex);
          if (
            BUILTIN_TOOL_TEXT_PREFIX.startsWith(buffered) &&
            buffered.length < BUILTIN_TOOL_TEXT_PREFIX.length
          ) {
            // 仍可能是协议头前缀（"*"、"**"…）：继续缓冲下一个增量
            blockPrefixBuffers.set(blockIndex, buffered);
            continue;
          }
          if (buffered.startsWith(BUILTIN_TOOL_TEXT_PREFIX)) {
            suppressedBlocks.add(blockIndex);
            continue;
          }
          yield {
            type: "text_delta",
            taskId: task.id,
            messageId: streamingMessageId,
            text: buffered,
          };
        } else if (m.event.type === "content_block_stop" && streamingMessageId) {
          // 块结束：冲刷仍在前缀缓冲里的短文本（不足判定长度即结束的普通文本块）
          const stopIndex = typeof m.event.index === "number" ? m.event.index : -1;
          const pending = stopIndex >= 0 ? blockPrefixBuffers.get(stopIndex) : undefined;
          if (pending !== undefined) {
            blockPrefixBuffers.delete(stopIndex);
            yield {
              type: "text_delta",
              taskId: task.id,
              messageId: streamingMessageId,
              text: pending,
            };
          }
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
