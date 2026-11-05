// 前端类型定义（SSE+HTTP 版本）
// 与 src/adapters/web-channel.ts 的 SSEEvent 保持一致

import type { LlmSdkType } from "./lib/llmSdk";

/** SSE 事件类型（与 src/adapters/web-channel.ts 的 SSEEvent 保持一致） */
export type SSEEvent =
  | { type: "text"; text: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "thinking_delta"; messageId: string; text: string }
  | { type: "tool_use"; toolUseId: string; tool: string; inputPreview: string }
  | { type: "tool_result"; toolUseId: string; outputPreview: string; isError: boolean }
  | {
      type: "approval_card";
      /** 一次性审批实例 id（respond 目标）；后端 ≥2026-09-24 必带，老服务端缺省时退回 gateId */
      approvalId?: string;
      gateId: string;
      title: string;
      summary: string;
      /** 一键成策略草稿（admin 轮 host_exec 审批；specs/2026-10-12 §8.1 M2） */
      adoptDraft?: { hostCode: string; prefix: string; agentId?: string };
    }
  | {
      /** 审批实例消亡（任务中断/他端已决议）：在看的客户端据此撤卡，防残卡点击 respond 恒 404 */
      type: "approval_closed";
      approvalId: string;
      reason: string;
    }
  | {
      type: "credential_missing_card";
      reqId: string;
      conversationId: string;
      items: Array<{
        code: string;
        name: string;
        description?: string;
        keys: string[];
      }>;
    }
  | {
      type: "ask_user_question";
      reqId: string;
      conversationId: string;
      questions: PendingQuestionItem[];
    }
  | {
      type: "result";
      subtype: "success" | "error";
      text: string;
      /** 轮次用量摘要（chat UE 轮回合徽标）：实时轮随 result 上屏，历史回看走 events 回放的 result 行 */
      usage?: TurnUsage;
    }
  | { type: "activity"; text: string }
  | {
      /** 会话排队深度（chat UE 轮）：busy 入队/出队时机广播，前端显示「排队中 · 第 N 位」 */
      type: "queue_depth";
      depth: number;
    }
  | {
      type: "eviction_notice";
      taskId: string;
      conversationId: string;
      taskExcerpt: string;
      startedAt: string;
      pendingSince: string;
      canceledAt: string;
    }
  /** 首条用户消息后后端异步自动改名：侧栏/头部标题实时刷新 */
  | { type: "conversation_title"; conversationId: string; title: string }
  /** 排水广播（热发布优雅停机）：服务更新中，当前对话完成后切换、新消息暂缓 */
  | { type: "server_draining"; deadline?: number; reason?: string }
  | { type: "error"; error: string };

/** 轮次用量摘要（回合徽标；与后端 SSE result.usage / audit result 行对齐，不含金额） */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  durationMs?: number;
}

/** 并发淘汰通知（eviction_notice 事件的前端形态，弹窗展示用） */
export interface EvictionNotice {
  taskId: string;
  conversationId: string;
  taskExcerpt: string;
  startedAt: string;
  pendingSince: string;
  canceledAt: string;
}

export type ChatRole = "user" | "bot";

export type MessageDelivery = "sending" | "accepted" | "failed";

/** 回合内的分型内容片段（同一回合内按时间线有序） */
export type TurnPart =
  | { kind: "text"; messageId: string; text: string }
  | { kind: "thinking"; messageId: string; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      tool: string;
      inputPreview: string;
      outputPreview?: string;
      isError?: boolean;
      state: "running" | "done" | "error";
    };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** 历史消息的落库时间（ISO）；本轮流式/本地乐观消息可能缺省 */
  createdAt?: string;
  delivery?: MessageDelivery;
  files?: Array<{
    path: string;
    name: string;
    type: "image" | "markdown" | "document";
  }>;
  /** 回合聚合消息（role=bot）：正文/思考/工具按时间线分片；缺省=旧式纯文本消息 */
  kind?: "turn";
  parts?: TurnPart[];
  /** 回合状态：running=流式进行中；done/error=已收口 */
  state?: "running" | "done" | "error";
  /** 归属任务 id（历史消息带，装饰/调试用） */
  taskId?: string;
  /** 回合内最后一条 bot 消息的服务端 id（消息级「从此分叉」的分叉点；流式回合不带） */
  forkPointMessageId?: string;
  /** 回合徽标元信息（chat UE 轮）：实时轮来自 result.usage，历史回合来自 events 回放 result 行 */
  meta?: TurnUsage;
  /** 本轮被用户停止（result.text=「已停止生成」；仅实时可判，历史回合不带） */
  stopped?: boolean;
  /** 客户端发送载荷（重试用，chat UE 轮 E5-A；仅本地乐观消息携带，不持久化） */
  sendPayload?: { text: string; files?: FileInfoLike[]; mentions?: unknown[] };
}

/** 附件形状（避免 types ↔ lib/chatReducer 循环依赖的本地最小结构） */
interface FileInfoLike {
  path: string;
  name: string;
  type: "image" | "markdown" | "document";
}

export interface PendingApproval {
  /** respond 目标 id = 后端下发的 approvalId（一次性实例），兼容老服务端时退回 gateId */
  respondId: string;
  gateId: string;
  title: string;
  summary: string;
  /** 一键成策略草稿（admin 轮 host_exec 审批；specs/2026-10-12 §8.1 M2） */
  adoptDraft?: { hostCode: string; prefix: string; agentId?: string };
}

export interface PendingCredential {
  reqId: string;
  items: Array<{
    code: string;
    name: string;
    description?: string;
    keys: string[];
  }>;
}

/** AskUserQuestion 单个问题（与后端 QuestionItem 对齐） */
export interface PendingQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** 一轮待作答问题（SSE ask_user_question / GET pending-question 共用） */
export interface PendingQuestion {
  reqId: string;
  questions: PendingQuestionItem[];
}

export type ConnectionState = "connecting" | "open" | "closed";

export type ChatErrorKey =
  | "conversations"
  | "messages"
  | "stream"
  | "approval"
  | "credential"
  | "question";

export type ChatErrors = Partial<Record<ChatErrorKey, string>>;

/**
 * 会话权限模式（2026-10-13 三档）：
 * - ask_before_change：命中审批门弹卡等人工决议；
 * - risk_guard（风险拦截）：常规门放行，风险不变量（出网白名单外/命令展开编码/解释器/
 *   bashAllowlist/git 写/部署）仍弹卡；
 * - full_access：零审批拦截（全部审批卡不再弹出），deny 级守卫（白名单/写边界/敏感读）仍生效。
 */
export type AgentPermissionMode = "ask_before_change" | "risk_guard" | "full_access";

/** 会话摘要（从 GET /api/conversations 返回） */
export interface ConversationSummary {
  id: string;
  userId: string;
  sdkSessionId: string;
  title: string;
  channelId: string;
  agentId: string;
  /** 会话级权限模式覆盖；空 = 跟随绑定智能体的默认配置 */
  permissionMode?: AgentPermissionMode;
  /** 生效权限模式（后端按 会话覆盖 ?? 智能体默认 ?? 变更前问询 计算） */
  effectivePermissionMode?: AgentPermissionMode;
  /** 最近一次运行所用执行引擎（agent sdk 标识）；空=未运行过 */
  llmSdkType?: LlmSdkType;
  /** 分叉血缘：源会话 id+标题（specs/2026-10-23-conversation-fork-design.md §8.3） */
  forkedFrom?: { id: string; title: string };
  /** 最后一条消息摘要（列表 enrich，chat UE 轮 E1-A；截 120 字） */
  lastMessagePreview?: string;
  /** 未读 bot 消息数（lastSeenAt 之后；cap 99） */
  unreadCount?: number;
  /** 用户最近打开时间（seen 端点回写；本地列表排序不依赖） */
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** 仅前端存在的未保存会话草稿。 */
  isDraft?: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  isGenerating: boolean;
  /** 当前执行阶段横幅（🔨 执行阶段等，后端 activity 事件；过程态，不随历史回放） */
  stage: string | null;
  /** 运行期活动摘要行（activity SSE，chat UE 轮 E2-A；滚窗 30 条，回合收口即清） */
  activityLines: string[];
  /** busy 排队深度（queue_depth SSE，chat UE 轮 E3-C；0=无排队） */
  queueDepth: number;
  /** SSE 断线自动重连尝试计数（chat UE 轮 E5-E；连接成功清零） */
  reconnectAttempts: number;
  pendingApproval: PendingApproval | null;
  pendingCredential: PendingCredential | null;
  pendingQuestion: PendingQuestion | null;
  /** 并发淘汰弹窗（最新一条；用户关闭后清空） */
  evictionNotice: EvictionNotice | null;
  connection: ConnectionState;
  /** 用户会话列表 */
  conversations: ConversationSummary[];
  /** 当前活跃会话 ID */
  activeConversationId: string | null;
  /** 会话列表加载中 */
  loadingConversations: boolean;
  /** 历史消息加载中 */
  loadingMessages: boolean;
  errors: ChatErrors;
}
