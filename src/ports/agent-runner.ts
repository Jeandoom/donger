import type { McpSdkServerConfigWithInstance, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "../domain/agent.js";
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
  /** Claude Agent SDK session ID，续接历史对话 */
  resume?: string;
  /** 写入边界：写入路径必须落在此目录内（该用户工作区） */
  workspaceRoot?: string;
  /** SDK cwd 之外允许访问的扩展目录。 */
  additionalDirectories?: string[];
  /** workspaceRoot 之外允许 direct write tools 写入的目录。 */
  allowedWriteRoots?: string[];
  /** SDK sandbox 尽力阻止写入的扩展目录。 */
  readOnlyRoots?: string[];
  /** RuntimeManager 注入的 transcript 适配器（SDK Alpha SessionStore） */
  sessionStore?: SessionStore;
  /** 能力快照版本号（审计/回溯用，M1 仅记录，不消费） */
  capabilityVersion?: number;
  /** 启用 pack 声明的凭证值（运行时注入 SDK env）。 */
  credentialsEnv?: Record<string, string>;
  /** 透传 SDK allowedTools（工具白名单） */
  allowedTools?: string[];
  /**
   * shell git 守卫（收口防线 2）：所有会话缺省禁止 Bash 跑 git（引导用 donger-git
   * 工具）；仅 agent 显式配置 true 时放行（push 仍有 deploy 审批门）。
   */
  gitAllowShellGit?: boolean;
  /** 透传 SDK mcpServers（已解密） */
  mcpServers?: McpServerConfig[];
  /** in-process 平台工具 MCP server（assist 会话注入；instance 不可序列化，仅运行时使用） */
  platformTools?: McpSdkServerConfigWithInstance;
  /** in-process git 平台元数据 MCP server（agent 绑定 git 仓库时注入） */
  gitPlatformTools?: McpSdkServerConfigWithInstance;
  /** in-process 业务知识库 MCP server（恒挂载，可用性由 agent tools 白名单控制） */
  kbTools?: McpSdkServerConfigWithInstance;
}

/** runner 命中审批门时回调；由 Orchestrator 实现（推卡 → 等用户 → 返回决议） */
export type ApprovalResolver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** 执行引擎端口：消费任务，产出事件流，门内调用 approvalResolver */
export interface AgentRunner {
  run(task: Task, opts: RunOptions, approvalResolver: ApprovalResolver): AsyncIterable<RunnerEvent>;
}
