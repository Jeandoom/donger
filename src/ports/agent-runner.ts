import type { McpSdkServerConfigWithInstance, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "../domain/agent.js";
import type { LLMConfig } from "../domain/llm-config.js";
import type { AgentPermissionMode } from "../domain/permission-mode.js";
import type { SensitiveReadPolicy } from "../domain/sensitive-read-guard.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  QuestionRequest,
  QuestionResolution,
  RunnerEvent,
  Task,
} from "../domain/types.js";

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
  /**
   * 会话权限模式取值器（每次工具调用现取，轮内切换立即生效）：
   * full_access 时命中审批门的调用直接放行；白名单/写边界/shell git 守卫不受影响。
   */
  permissionMode?: () => AgentPermissionMode;
  /** 透传 SDK mcpServers（已解密） */
  mcpServers?: McpServerConfig[];
  /** 插件共享运行库目录（<plugin>/scripts，存在才注入）：
   *  runner 并入 PYTHONPATH，供技能脚本 `from credentials import ...` 等共享包导入 */
  pythonPaths?: string[];
  /** in-process 平台工具 MCP server（assist 会话注入；instance 不可序列化，仅运行时使用） */
  platformTools?: McpSdkServerConfigWithInstance;
  /** in-process git 平台元数据 MCP server（agent 绑定 git 仓库时注入） */
  gitPlatformTools?: McpSdkServerConfigWithInstance;
  /** in-process 业务知识库 MCP server（恒挂载，可用性由 agent tools 白名单控制） */
  kbTools?: McpSdkServerConfigWithInstance;
  /** KB 目录根清单（<workspaceDir>/kb/<kbId>）：Bash 写守卫的敏感根（spec §9，D6）——
   *  Bash 命中写模式+这些根 → deny+引导 kb_* 工具；KB 目录不进 allowedWriteRoots，本清单只供守卫 */
  kbWriteGuardRoots?: string[];
  /**
   * 服务端要害路径读守卫（2026-09-24 审计 H1/D3 收口）：denyRoots（生产库/部署目录/
   * 平台源码/其他用户工作区）中的路径禁止 Bash 与 Read 工具触达，allowReadRoots
   * （本人工作区等）优先。双层执行：canUseTool 字符串守卫 + SDK sandbox denyRead。
   */
  sensitiveReadPolicy?: SensitiveReadPolicy;
  /** in-process 审计读取 MCP server（内置审计/技能工坊智能体注入；viewer 在构造时闭包绑定） */
  auditTools?: McpSdkServerConfigWithInstance;
  /**
   * AskUserQuestion 交互桥（可选）：CLI 把该工具的用户交互搭在权限通道（checkPermissions
   * 恒 behavior:"ask"），期望宿主收集答案后以 updatedInput.answers 放行。未提供时按
   * 原样放行（空答案 → 模型收到 "The user did not answer the questions."，即历史行为）。
   */
  questionResolver?: QuestionResolver;
}

/** runner 命中 AskUserQuestion 时回调；由 Orchestrator 实现（推问题卡 → 等用户作答 → 返回答案） */
export type QuestionResolver = (req: QuestionRequest) => Promise<QuestionResolution>;

/** runner 命中审批门时回调；由 Orchestrator 实现（推卡 → 等用户 → 返回决议） */
export type ApprovalResolver = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** 执行引擎端口：消费任务，产出事件流，门内调用 approvalResolver */
export interface AgentRunner {
  run(task: Task, opts: RunOptions, approvalResolver: ApprovalResolver): AsyncIterable<RunnerEvent>;
  /**
   * 该任务当前是否在等用户作答（AskUserQuestion 桥接挂起中）。停摆看门狗据此豁免：
   * 等人工输入是合法阻塞而非流挂死。可选能力——未实现者视为恒不豁免。
   */
  isAwaitingUserInput?(taskId: string): boolean;
}
