import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { McpServerConfig } from "../domain/agent.js";
import type { GateRouter } from "../domain/gate-router.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { scanSkillPack } from "../domain/skill-scan.js";
import type { RunnerEvent, Task, TokenUsage } from "../domain/types.js";
import type { AgentRunner, ApprovalResolver, RunOptions } from "../ports/agent-runner.js";
import type { ChatUpstreamConfig, CodexChatBridge } from "./codex-chat-bridge.js";

/**
 * OpenAI 引擎 runner：用 Codex Agent SDK（codex exec 通道）驱动。
 *
 * 与 ClaudeAgentRunner 的关键差异（specs/2026-09-21-codex-openai-runner-design.md）：
 * - 推理恒经内置 Responses↔Chat 桥（codex 0.155+ 已移除 chat wire；上游 key 留桥内）；
 * - 无交互审批通道：审批门语义=静态拒绝（execpolicy 规则 + 沙箱），AskUserQuestion 不可用；
 * - 写边界=沙箱 workspace-write（写限 runtimeDir，additionalDirectories 只读）；
 * - 会话续接走 codex 原生 thread（CODEX_HOME 按用户隔离），不消费 sessionStore。
 */

// —— Codex SDK 结构化类型（不直接 import SDK 类型，测试注入假实现） ——

export interface CodexThreadEventLike {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  item?: CodexItemLike;
}

export interface CodexItemLike {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
  [key: string]: unknown;
}

export interface CodexThreadLike {
  id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexThreadEventLike> }>;
}

export interface CodexClientLike {
  startThread(options: Record<string, unknown>): CodexThreadLike;
  resumeThread(threadId: string, options?: Record<string, unknown>): CodexThreadLike;
}

export type CodexClientFactory = (options: Record<string, unknown>) => CodexClientLike;

/** 白名单中视为具备写能力的工具（其余工具全部命中→沙箱降 read-only，决策点 ②） */
const WRITE_CAPABLE_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit", "apply_patch"]);

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * 沙箱模式解析：
 * - 基线=启发式：白名单全只读工具→read-only；否则 workspace-write（写限 cwd）。
 * - 逃生门：DONGER_CODEX_SANDBOX_MODE 显式指定（admin 级 env）。Windows 宿主沙箱
 *   setup 失败是已知 open bug（openai/codex#43416 等），此时 codex 自动降级只读——
 *   只读分析类 agent 仍可用；写类 agent 需 admin 显式设 danger-full-access（自担风险，
 *   防线剩 execpolicy 静态规则+审计），或等上游修复。非法取值忽略回退基线。
 * - 白名单只读的 agent 恒 read-only（逃生门不升级只读白名单，最小权限优先）。
 */
export function resolveSandboxMode(
  allowedTools: string[] | undefined,
  override: string | undefined,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (allowedTools && !allowedTools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool))) {
    return "read-only";
  }
  if (override && SANDBOX_MODES.has(override)) {
    return override as "read-only" | "workspace-write" | "danger-full-access";
  }
  return "workspace-write";
}

export class CodexAgentRunner implements AgentRunner {
  constructor(
    /** 审批门登记表：M1 无逐调用拦截通道，保留引用供 M2 MCP 桥内静态校验复用 */
    private readonly gates: GateRouter,
    private readonly bridge: CodexChatBridge,
    private readonly codexFactory: CodexClientFactory = defaultCodexFactory,
  ) {}

  /** codex 引擎无 AskUserQuestion 通道：恒不在等用户输入（看门狗不豁免） */
  isAwaitingUserInput(_taskId: string): boolean {
    return false;
  }

  async *run(
    task: Task,
    opts: RunOptions,
    _resolver: ApprovalResolver,
  ): AsyncIterable<RunnerEvent> {
    const ac = new AbortController();
    opts.abortSignal?.addEventListener("abort", () => ac.abort(), { once: true });

    const cwd = resolve(opts.cwd);
    const additionalDirectories = opts.additionalDirectories?.map((path) => resolve(path)) ?? [];
    const llm: LLMConfig = { ...opts.llm, sdkType: opts.llm.sdkType ?? "openai" };
    // 防御性兜底：正常链路 runtimeDir 由 ensureRuntimeDir 预建，直连调用（冒烟/调试）可能未建
    mkdirSync(cwd, { recursive: true });

    // 沙箱模式：白名单启发 + admin 逃生门（见 resolveSandboxMode 注释）
    const sandboxMode = resolveSandboxMode(
      opts.allowedTools,
      process.env.DONGER_CODEX_SANDBOX_MODE,
    );

    // CODEX_HOME 按用户隔离（workspaceRoot=user.homeDir）：sessions/rollout、skills 物化、规则
    const codexHome = join(resolve(opts.workspaceRoot ?? cwd), ".codex-home");
    const skillsHome = join(codexHome, "skills");
    mkdirSync(skillsHome, { recursive: true });

    // execpolicy 静态规则（codex 加载 CODEX_HOME/rules/*.rules；冒烟实锤：danger-full-access 下仍生效）：
    // shell git 守卫的 codex 侧等价物——缺省禁全部 git（与 canUseTool 守卫同口径）；
    // agent 显式开启 shell git 时仅禁 push（决策点 ③A：openai 会话 push 一律 forbidden）。
    const rulesHome = join(codexHome, "rules");
    mkdirSync(rulesHome, { recursive: true });
    writeFileSync(
      join(rulesHome, "donger.rules"),
      opts.gitAllowShellGit === true
        ? 'prefix_rule(pattern=["git", "push"], decision="forbidden")\n'
        : 'prefix_rule(pattern=["git"], decision="forbidden")\n',
    );

    // 系统提示 → AGENTS.md（codex 从 cwd 读取）；含不可信数据前言/扩展目录/仓库提示（与 claude 口径一致）
    if (opts.systemPromptAppend?.trim()) {
      writeFileSync(join(cwd, "AGENTS.md"), `${opts.systemPromptAppend.trim()}\n`);
    }

    materializeWhitelistedSkills(opts.skills ?? [], opts.pluginPaths ?? [], skillsHome);

    const upstreamToken = randomUUID();
    const bridgePort = await this.bridge.ensureStarted();
    const upstream: ChatUpstreamConfig = {
      baseUrl: llm.baseUrl,
      apiKey: llm.authToken,
      model: llm.model,
    };
    this.bridge.registerUpstream(upstreamToken, upstream);

    // —— MCP 装配（M2）——
    // in-process 平台工具台（platform/git/host/kb/audit）：桥上挂 Streamable HTTP 端点给 codex，
    // 审批门命中在桥内静态拒绝（决策点 ①A）。连接器 stdio/http mcpServers：headers 凭证经
    // env_http_headers 注入（值只进 env，不进 argv 防 --config 泄漏面）。
    const mcpServerConfigs: Record<string, unknown> = {};
    const mcpHeaderEnv: Record<string, string> = {};
    let mcpHeaderIndex = 0;
    for (const sdkTools of [
      opts.platformTools,
      opts.gitPlatformTools,
      opts.hostTools,
      opts.kbTools,
      opts.auditTools,
    ]) {
      if (!sdkTools) continue;
      const url = await this.bridge.mountMcp(
        upstreamToken,
        sdkTools.name,
        sdkTools.instance as never,
        (tool, args) => this.gates.match(tool, args),
      );
      mcpServerConfigs[sdkTools.name] = { url };
    }
    for (const server of (opts.mcpServers ?? []) as McpServerConfig[]) {
      if (server.type === "stdio") {
        mcpServerConfigs[server.name] = {
          command: server.command,
          ...(server.args?.length ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        };
      } else {
        const envHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(server.headers ?? {})) {
          const envName = `DONGER_MCPH_${mcpHeaderIndex}`;
          mcpHeaderIndex += 1;
          mcpHeaderEnv[envName] = value;
          envHeaders[key] = envName;
        }
        mcpServerConfigs[server.name] = {
          url: server.url,
          ...(Object.keys(envHeaders).length > 0 ? { env_http_headers: envHeaders } : {}),
        };
      }
    }

    try {
      const client = this.codexFactory({
        // SDK 的 env 是整体替换：Windows 子进程必需项（PATH/SYSTEMROOT 等）随 process.env 全量带入
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          DONGER_BRIDGE_TOKEN: upstreamToken,
          ...opts.credentialsEnv,
          ...mcpHeaderEnv,
          ...(opts.pythonPaths?.length
            ? {
                PYTHONPATH: [
                  ...opts.pythonPaths.map((path) => resolve(path)),
                  ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : []),
                ].join(delimiter),
              }
            : {}),
        },
        config: {
          model_provider: "donger-bridge",
          model_providers: {
            "donger-bridge": {
              name: "donger-bridge",
              base_url: `http://127.0.0.1:${bridgePort}/v1`,
              // 0.155+ 仅存 responses 线协议；chat/completions 翻译在桥内完成
              wire_api: "responses",
              // 上游凭证不在 env_key 里（桥内注册），run-token 仅作桥鉴权
              env_http_headers: { "x-donger-bridge": "DONGER_BRIDGE_TOKEN" },
            },
          },
          approval_policy: "never",
          sandbox_mode: sandboxMode,
          ...(Object.keys(mcpServerConfigs).length > 0 ? { mcp_servers: mcpServerConfigs } : {}),
        },
      });
      const threadOptions: Record<string, unknown> = {
        model: llm.model,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy: "never",
        webSearchMode: "disabled",
        // 缺省断网（沙箱网络关闭）：与「agent 不可直连外网、外发走工具+门」的平台哲学一致；
        // agent 显式开启 shell git 时放开（git clone/fetch 需网络）
        networkAccessEnabled: opts.gitAllowShellGit === true,
        ...(additionalDirectories.length ? { additionalDirectories } : {}),
      };
      const thread = opts.resume
        ? client.resumeThread(opts.resume, threadOptions)
        : client.startThread(threadOptions);

      yield {
        type: "llm_input",
        taskId: task.id,
        input: serializeJson({
          prompt: task.prompt,
          engine: "codex",
          options: {
            cwd,
            model: llm.model,
            sdkType: "openai",
            sandboxMode,
            resume: opts.resume ?? null,
            skills: opts.skills,
            additionalDirectories,
            agentPermissionMode: opts.permissionMode?.(),
            workspaceRoot: opts.workspaceRoot,
            capabilityVersion: opts.capabilityVersion,
            credentialKeys: Object.keys(opts.credentialsEnv ?? {}),
            note: "openai 引擎：审批门=静态拒绝、AskUserQuestion 不可用、写限 runtimeDir",
          },
        }),
      };

      const { events } = await thread.runStreamed(task.prompt, { signal: ac.signal });

      // 增量文本：item.updated 携带累计文本 → 差量后发（与 claude text_delta 追加语义对齐）
      const emitted = new Map<string, string>();
      let finalText = "";
      for await (const event of events) {
        if (event.type === "thread.started") {
          yield { type: "session_init", taskId: task.id, sessionId: event.thread_id ?? "" };
          continue;
        }
        if (event.type === "turn.started") continue;
        if (event.type === "turn.completed") {
          const usage: TokenUsage = {
            inputTokens: event.usage?.input_tokens ?? 0,
            outputTokens: event.usage?.output_tokens ?? 0,
            cacheReadInputTokens: event.usage?.cached_input_tokens ?? 0,
            // 决策点 ④B：cache_write_input_tokens 无 claude 对应口径，丢弃
            cacheCreationInputTokens: 0,
          };
          yield {
            type: "result",
            taskId: task.id,
            subtype: "success",
            result: finalText || undefined,
            usage,
          };
          continue;
        }
        if (event.type === "turn.failed" || event.type === "error") {
          // 错误原文透传：上层自愈/诊断依赖原始文本（与 claude runner 同坑位）
          yield {
            type: "result",
            taskId: task.id,
            subtype: "error",
            error: event.error?.message || event.message || "agent 执行出错",
          };
          continue;
        }
        if (event.type === "item.started") {
          const use = itemToToolUse(event.item);
          if (use) yield { type: "tool_use", taskId: task.id, ...use };
          continue;
        }
        if (event.type === "item.updated") {
          const item = event.item;
          if (item?.type === "agent_message" && typeof item.text === "string") {
            const delta = incrementalSuffix(item.id, item.text, emitted);
            if (delta) {
              finalText = item.text;
              yield {
                type: "text_delta",
                taskId: task.id,
                messageId: item.id,
                text: delta,
              };
            }
          } else if (item?.type === "reasoning" && typeof item.text === "string" && item.text) {
            yield {
              type: "thinking_delta",
              taskId: task.id,
              messageId: item.id,
              text: item.text,
            };
          }
          continue;
        }
        if (event.type === "item.completed") {
          const item = event.item;
          if (!item) continue;
          if (item.type === "agent_message") {
            if (typeof item.text === "string") {
              const delta = incrementalSuffix(item.id, item.text, emitted);
              if (delta) {
                finalText = item.text;
                yield { type: "text_delta", taskId: task.id, messageId: item.id, text: delta };
              }
              yield { type: "text", taskId: task.id, text: item.text };
            }
            yield { type: "llm_output", taskId: task.id, output: serializeJson(item) };
          } else {
            yield { type: "llm_output", taskId: task.id, output: serializeJson(item) };
            const outcome = itemToToolOutcome(item);
            if (outcome) yield { type: "tool_result", taskId: task.id, ...outcome };
          }
        }
      }
    } finally {
      await this.bridge.unmountAllMcp(upstreamToken);
      this.bridge.unregisterUpstream(upstreamToken);
    }
  }
}

/** 累计文本 → 追加增量（非前缀扩展时跳过，防乱序重复） */
function incrementalSuffix(itemId: string, fullText: string, emitted: Map<string, string>): string {
  const prev = emitted.get(itemId) ?? "";
  if (fullText.length <= prev.length || !fullText.startsWith(prev)) return "";
  emitted.set(itemId, fullText);
  return fullText.slice(prev.length);
}

/** item.started → tool_use 事件载荷（command/mcp/web_search 即刻成卡；file_change 无 started 形态） */
function itemToToolUse(
  item: CodexItemLike | undefined,
): { tool: string; input: Record<string, unknown>; toolUseId: string } | undefined {
  if (!item) return undefined;
  switch (item.type) {
    case "command_execution":
      return {
        tool: "Bash",
        input: { command: item.command ?? "" },
        toolUseId: item.id,
      };
    case "mcp_tool_call":
      return {
        tool: `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`,
        input: (item.arguments as Record<string, unknown> | undefined) ?? {},
        toolUseId: item.id,
      };
    case "web_search":
      return {
        tool: "WebSearch",
        input: { query: (item as { query?: string }).query ?? "" },
        toolUseId: item.id,
      };
    default:
      return undefined;
  }
}

/** item.completed → tool_result 事件载荷（file_change 在 completed 一次性成对补发） */
function itemToToolOutcome(item: CodexItemLike):
  | {
      toolUseId: string;
      content: string;
      isError: boolean;
      tool?: string;
      input?: Record<string, unknown>;
    }
  | undefined {
  switch (item.type) {
    case "command_execution":
      return {
        toolUseId: item.id,
        content:
          `${item.aggregated_output ?? ""}${item.exit_code !== undefined ? `\n[exit_code: ${item.exit_code}]` : ""}`.trim(),
        isError: item.status === "failed",
      };
    case "file_change": {
      const changes = (item.changes ?? []).map((c) => `${c.kind}: ${c.path}`).join("\n");
      return {
        toolUseId: item.id,
        content: changes || "(无变更)",
        isError: item.status === "failed",
        // file_change 无 started 事件：补发成对 tool_use 保前端卡片完整
        tool: "apply_patch",
        input: { changes: item.changes ?? [] },
      };
    }
    case "mcp_tool_call": {
      if (item.error) {
        return { toolUseId: item.id, content: item.error.message ?? "MCP 调用失败", isError: true };
      }
      const text = (item.result?.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
      return {
        toolUseId: item.id,
        content: text || JSON.stringify(item.result?.content ?? []),
        isError: item.status === "failed",
      };
    }
    case "web_search":
      return { toolUseId: item.id, content: "(搜索完成)", isError: false };
    default:
      return undefined;
  }
}

/**
 * 白名单技能物化：从 pluginPaths（claude 插件布局）里挑出 agent 白名单技能，
 * 复制到 CODEX_HOME/skills（codex 原生技能目录）。pack 名取插件 plugin.json，
 * 技能目录按 scanSkillPack 的 frontmatter name 匹配（生成布局目录名可能被去重改名）。
 */
export function materializeWhitelistedSkills(
  skills: string[],
  pluginPaths: string[],
  skillsHome: string,
): void {
  if (skills.length === 0 || pluginPaths.length === 0) return;
  const wanted = new Map<string, Set<string>>();
  for (const id of skills) {
    const sep = id.indexOf(":");
    if (sep <= 0 || sep === id.length - 1) continue;
    const packName = id.slice(0, sep);
    const skillName = id.slice(sep + 1);
    const set = wanted.get(packName) ?? new Set<string>();
    set.add(skillName);
    wanted.set(packName, set);
  }
  if (wanted.size === 0) return;

  for (const pluginPath of pluginPaths) {
    if (!existsSync(pluginPath)) continue;
    const packName = readPluginName(pluginPath);
    const selected = packName ? wanted.get(packName) : undefined;
    if (!selected || selected.size === 0) continue;
    let scanned: ReturnType<typeof scanSkillPack>;
    try {
      scanned = scanSkillPack(pluginPath);
    } catch {
      continue;
    }
    for (const skill of scanned.skills) {
      if (!selected.has(skill.name)) continue;
      const sourceDir = join(pluginPath, skill.relativePath, "..");
      const target = join(skillsHome, skill.name);
      rmSync(target, { recursive: true, force: true });
      try {
        cpSync(sourceDir, target, { recursive: true });
      } catch {
        // 单技能物化失败不阻断运行（codex 缺该技能仅能力降级）
      }
    }
  }
}

function readPluginName(pluginPath: string): string | undefined {
  const marker = join(pluginPath, ".claude-plugin", "plugin.json");
  if (!existsSync(marker)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 真实 SDK 工厂：new Codex(options)（结构兼容 CodexClientLike；单测注入假实现不经此路径） */
function defaultCodexFactory(options: Record<string, unknown>): CodexClientLike {
  return new Codex(options as never) as unknown as CodexClientLike;
}
