import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TriggerMatcherSchema } from "./event-matcher.js";

export type { TriggerMatcher } from "./event-matcher.js";
export { TriggerMatcherSchema } from "./event-matcher.js";

/**
 * 事件（原触发器）三分法（spec 2026-10-09-events-workflows-refactor-design §3.1）：
 * - system：系统默认事件（注册表内进程内事件，如 feedback.created；创建/编辑 admin-only）
 * - schedule：定时事件；unconditional=纯定时到点即触发，conditional=抓取源+matcher 判定（原 scheduler 形态）
 * - call：调用事件（外部系统回调，原 hook）；path 服务端生成随机、不可自定义（D2）
 * git 类型已随本轮退役（GitWatcher 移除）。
 */

/** 进程内系统事件名注册表；新事件源（KB 变更/会话完结等）在此追加即可复用整条投递管线。
 * payload 契约见 domain/event-payloads.ts */
export const SYSTEM_EVENT_NAMES = ["feedback.created"] as const;
export type SystemEventName = (typeof SYSTEM_EVENT_NAMES)[number];

/** 调用事件支持的 HTTP 方法（D3：GET+POST 同时开放，随机路径+限流兜底） */
export const CALL_EVENT_METHODS = ["GET", "POST"] as const;

/** 调用事件路径：服务端生成不可猜随机 slug，每事件独立路径（D2） */
export function generateCallPath(): string {
  return `/hooks/${randomBytes(8).toString("hex")}`;
}

export const EventSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().min(1),
  }),
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/** 有条件定时配置（无条件定时不含 source/matcher） */
export const EventScheduleConfigSchema = z.object({
  cron: z.string().min(1),
  mode: z.enum(["unconditional", "conditional"]).default("conditional"),
  source: EventSourceSchema.optional(),
  matcher: TriggerMatcherSchema.optional(),
});
export type EventScheduleConfig = z.infer<typeof EventScheduleConfigSchema>;

/** 调用事件配置：path 由服务端生成 /hooks/<random>，输入面不可指定 */
export const EventCallConfigSchema = z.object({
  // path 服务端所有（生成随机 slug）；输入面仅做形状校验（宽容连字符/空，服务端落库前覆盖）
  path: z.string().regex(/^\/hooks\/[a-z0-9-_]*$/i),
  methods: z.array(z.enum(CALL_EVENT_METHODS)).default(["GET", "POST"]),
  responseStatus: z.number().int().min(100).max(599).default(200),
  responseBody: z.string().default(""),
  matcher: TriggerMatcherSchema.default({ kind: "always" }),
});
export type EventCallConfig = z.infer<typeof EventCallConfigSchema>;

/** 系统事件配置：订阅注册表中的进程内事件，matcher 判定事件 payload JSON */
export const EventSystemConfigSchema = z.object({
  name: z.enum(SYSTEM_EVENT_NAMES),
  matcher: TriggerMatcherSchema.default({ kind: "always" }),
});
export type EventSystemConfig = z.infer<typeof EventSystemConfigSchema>;

const EventBaseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1).max(64),
  type: z.enum(["system", "schedule", "call"]),
  system: EventSystemConfigSchema.optional(),
  schedule: EventScheduleConfigSchema.optional(),
  call: EventCallConfigSchema.optional(),
  /** 运行态（展示用）：最近一次触发 / 定时事件下次触发 */
  lastFiredAt: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ponytail: DRY——schema 和 input schema 用同一 refine，避免维护双写
function eventTypeRefine(
  t: { type: string; system?: unknown; schedule?: unknown; call?: unknown },
  ctx: z.RefinementCtx,
) {
  if (t.type === "system" && !t.system) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "system 类型必须提供 system 配置" });
  }
  if (t.type === "schedule" && !t.schedule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "schedule 类型必须提供 schedule 配置" });
  }
  if (t.type === "call" && !t.call) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "call 类型必须提供 call 配置" });
  }
  const sched = t.schedule as EventScheduleConfig | undefined;
  if (t.type === "schedule" && sched) {
    if (sched.mode === "conditional" && (!sched.source || !sched.matcher)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "有条件定时必须提供 source 与 matcher",
      });
    }
  }
}

export const EventInputSchema = EventBaseSchema.omit({
  id: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  lastFiredAt: true,
  nextRunAt: true,
}).superRefine(eventTypeRefine);
export type EventInput = z.infer<typeof EventInputSchema>;

export const EventSchema = EventBaseSchema.superRefine(eventTypeRefine);
export type Event = z.infer<typeof EventSchema>;

export function parseEventInput(raw: unknown): EventInput {
  return EventInputSchema.parse(raw);
}

/** 触发来源（EventFiring.source / WorkflowRun.eventName 前缀语义） */
export type EventFireSource = "manual" | "schedule" | "call" | "system";

/** 事件一次触发的上下文：payload=matcher 判定对象+{{triggerOutput}} 变量原文 */
export interface FireContext {
  payload: string;
  /** 调用事件归一后的文本字段（{{query}}）；其余类型缺省 */
  query?: string;
  /** 调用事件归一后的结构化字段（{{data}}，对象） */
  data?: Record<string, unknown>;
}

/**
 * 提示词变量表（spec §6）：{{triggerOutput}} 恒在（=payload 原文，存量模板零迁移），
 * 调用事件追加 {{query}}/{{data}}（data 为美化 JSON）。未知 {{xxx}} 保持字面量。
 * 外部内容的 wrapUntrusted 包装在渲染管线统一做（这里只产纯变量）。
 */
export function buildPromptVars(ctx: FireContext, firedAt: string): Record<string, string> {
  const vars: Record<string, string> = {
    triggerOutput: ctx.payload,
    firedAt,
    query: ctx.query ?? "",
    data: ctx.data ? JSON.stringify(ctx.data, null, 2) : "",
  };
  return vars;
}

/** 多变量模板渲染：逐 key 全量替换；未提供的占位符保持字面量 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}
