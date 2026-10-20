/**
 * 事件触发器 payload 契约（spec 2026-09-28-event-trigger-feedback-design §4）。
 * payload 是 sourceOutput——与 hook body 同语义：matcher 的判定对象、经 wrapUntrusted
 * 注入 prompt 模板的不可信内容。契约归发射方；此处只收口「构造」保证两端形状一致。
 */
import { FEEDBACK_CATEGORY_LABELS, type FeedbackCategory } from "./feedback.js";

export interface FeedbackCreatedFact {
  id: string;
  category: FeedbackCategory;
  status: string;
  content: string;
  submitterId: string;
  /** userStore 解析，查不到降级 submitterId（由发射方负责） */
  submitterName: string;
  imageCount: number;
  /** 关联应用（应用管家制 spec §7；弱引用原样携带） */
  appId?: string | null;
  createdAt: string;
}

export function buildFeedbackCreatedPayload(fact: FeedbackCreatedFact): string {
  return JSON.stringify({
    event: "feedback.created",
    feedback: { ...fact, categoryLabel: FEEDBACK_CATEGORY_LABELS[fact.category] },
  });
}

/** testTrigger 用固定样例（不取真实反馈；时间戳固定保证测试确定性） */
export function sampleFeedbackCreatedPayload(): string {
  return buildFeedbackCreatedPayload({
    id: "00000000-0000-4000-8000-000000000000",
    category: "feature",
    status: "open",
    content: "（样例反馈）希望导出功能支持自定义字段",
    submitterId: "sample-user",
    submitterName: "样例用户",
    imageCount: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
}

// 应用生命周期事件（app.published/app.rolled_back）随应用模块于 2026-09-30 移除；
// FeedbackCreatedFact.appId 为弱引用软关联，历史行悬空无害，字段保留。

// ===== 执行完成事件（spec 2026-10-19-execution-completion-events-design）=====
// 薄信封 + 自由内容（MCP content-blocks / A2A artifact 同款分层）：信封字段供平台代码
// 消费（路由/属主守卫/级联守卫），result 内容零 schema 义务——订阅方是 LLM，下游渲染
// 自然语言简报注入（§6），JSON 只是存储格式。

export const AGENT_EXECUTION_COMPLETED_EVENT = "agent.execution.completed";
export const WORKFLOW_EXECUTION_COMPLETED_EVENT = "workflow.execution.completed";
export const EXECUTION_COMPLETION_EVENT_NAMES = [
  AGENT_EXECUTION_COMPLETED_EVENT,
  WORKFLOW_EXECUTION_COMPLETED_EVENT,
] as const;
export type ExecutionCompletionEventName = (typeof EXECUTION_COMPLETION_EVENT_NAMES)[number];

export function isExecutionCompletedEventName(name: string): boolean {
  return (EXECUTION_COMPLETION_EVENT_NAMES as readonly string[]).includes(name);
}

export type ExecutionCompletionStatus = "success" | "failed" | "stopped";
export type ExecutionTiming = "all" | ExecutionCompletionStatus;

/** 产物引用：仅物化所需最小元数据（D7；M1 恒空数组，M2 由产物库填充） */
export interface ExecutionFileRef {
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: "image" | "document" | "code" | "audio" | "video" | "archive" | "other";
  /** 稳定句柄 artifact://run-<id>/<name>，不暴露真实盘路径 */
  ref: string;
}

export interface ExecutionCompletedFact {
  schemaVersion: 1;
  event: ExecutionCompletionEventName;
  runId: string;
  agentId: string;
  agentName: string;
  workflowId: string;
  workflowName: string;
  /** 属主（dispatch 硬守卫消费，D4；模板作者不感知） */
  ownerId: string;
  status: ExecutionCompletionStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error: string | null;
  trigger: {
    /** event | schedule | call | manual（由 run.eventName 前缀推导） */
    source: string;
    eventId: string | null;
    causedByRunId: string | null;
    cascadeDepth: number;
  };
  result: {
    /** 最终 assistant 回复原文（markdown 原样，截断见下）；无 schema */
    text: string;
    files: ExecutionFileRef[];
  };
  /**
   * 业务因果键（可选；spec 2026-10-20-feedback-notify-loop §M1）：白名单透传——
   * 只认 feedback.created 触发载荷的 feedbackId/submitterId，薄信封不装自由 context。
   * 下游级联（通知/回复闭环）据此定位提交人与反馈单，老 payload 无此字段照常解析。
   */
  correlation?: ExecutionCorrelation;
}

export interface ExecutionCorrelation {
  feedbackId: string;
  submitterId: string;
}

/**
 * 从触发载荷提取业务因果键（白名单硬编码 feedback 域，2026-10-20 拍板②）。
 * 非 feedback.created 载荷 / 形状缺失 → null。
 */
export function extractExecutionCorrelation(payload: string): ExecutionCorrelation | null {
  try {
    const raw = JSON.parse(payload) as { event?: unknown; feedback?: unknown } | null;
    if (raw?.event !== "feedback.created") return null;
    // FeedbackCreatedFact 序列化形状：feedback.id / feedback.submitterId
    const fb = raw.feedback as { id?: unknown; submitterId?: unknown } | undefined;
    if (
      typeof fb?.id === "string" &&
      fb.id &&
      typeof fb.submitterId === "string" &&
      fb.submitterId
    ) {
      return { feedbackId: fb.id, submitterId: fb.submitterId };
    }
    return null;
  } catch {
    return null;
  }
}

export const EXECUTION_RESULT_TEXT_MAX_CHARS = 2000;

export function truncateExecutionResultText(text: string): string {
  return text.length > EXECUTION_RESULT_TEXT_MAX_CHARS
    ? `${text.slice(0, EXECUTION_RESULT_TEXT_MAX_CHARS)}…[已截断]`
    : text;
}

export function buildExecutionCompletedPayload(fact: ExecutionCompletedFact): string {
  return JSON.stringify(fact);
}

/** 信封容错解析：非完成事件 payload / 形状不符 → null（调用方走普通事件路径） */
export function parseExecutionCompletedPayload(payload: string): ExecutionCompletedFact | null {
  try {
    const raw = JSON.parse(payload) as Partial<ExecutionCompletedFact> | null;
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion !== 1) return null;
    if (!raw.event || !isExecutionCompletedEventName(raw.event)) return null;
    if (typeof raw.runId !== "string" || !raw.runId) return null;
    if (typeof raw.ownerId !== "string" || !raw.ownerId) return null;
    if (typeof raw.trigger?.cascadeDepth !== "number") return null;
    if (typeof raw.result?.text !== "string" || !Array.isArray(raw.result.files)) return null;
    // correlation 可选；存在但形状残缺则剥除（信封尽力而为，不让坏键毒化下游）
    const c = raw.correlation as Partial<ExecutionCorrelation> | undefined;
    const correlation: ExecutionCorrelation | undefined =
      typeof c?.feedbackId === "string" &&
      c.feedbackId &&
      typeof c.submitterId === "string" &&
      c.submitterId
        ? { feedbackId: c.feedbackId, submitterId: c.submitterId }
        : undefined;
    return { ...(raw as ExecutionCompletedFact), correlation };
  } catch {
    return null;
  }
}

/**
 * 完成事件订阅判定（spec §4.3）：属主硬守卫 + 主体命中 + 时机过滤，纯函数。
 * 只认 subjects/timing 一等字段，不走 payload matcher（D2）。
 */
export function matchExecutionCompletedSubscription(
  sub: { ownerId: string; name: string; subjects?: string[]; timing?: ExecutionTiming },
  fact: ExecutionCompletedFact,
): boolean {
  if (sub.ownerId !== fact.ownerId) return false;
  const subject = sub.name === AGENT_EXECUTION_COMPLETED_EVENT ? fact.agentId : fact.workflowId;
  if (!sub.subjects?.includes(subject)) return false;
  const timing = sub.timing ?? "all";
  return timing === "all" || timing === fact.status;
}

const EXECUTION_FILE_CATEGORY_LABELS: Record<ExecutionFileRef["category"], string> = {
  image: "图片",
  document: "文档",
  code: "代码",
  audio: "音频",
  video: "视频",
  archive: "压缩包",
  other: "文件",
};

function formatExecutionBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** {{filesManifest}} 变量：交付文件清单文本（M1 files 恒空 → 空串，调用方兜底「（无）」） */
export function buildExecutionFilesManifest(files: ExecutionFileRef[]): string {
  return files
    .map(
      (f) =>
        `./artifacts/${f.name} — ${EXECUTION_FILE_CATEGORY_LABELS[f.category] ?? "文件"} ${formatExecutionBytes(f.sizeBytes)}`,
    )
    .join("\n");
}

const EXECUTION_STATUS_WORDS: Record<ExecutionCompletionStatus, string> = {
  success: "成功完成",
  failed: "执行失败",
  stopped: "被终止",
};

export function executionStatusWord(status: ExecutionCompletionStatus): string {
  return EXECUTION_STATUS_WORDS[status];
}

export function formatExecutionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 简报模板（订阅完成事件的工作流默认 promptTemplate；web 端同串预填）。
 * JSON 是存储格式、简报是呈现格式——下游 LLM 默认看不到 JSON（spec §6）。
 */
export const WORKFLOW_COMPLETION_BRIEFING_TEMPLATE = `【上游完成通知】工作流「{{workflowName}}」中的智能体「{{agentName}}」已{{statusWord}}（耗时 {{durationText}}）。
结论：
{{outputSummary}}

交付文件：
{{filesManifest}}

请基于上游执行结论继续任务。`;
