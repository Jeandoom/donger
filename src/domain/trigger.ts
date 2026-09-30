import { z } from "zod";

export const TriggerSourceSchema = z.discriminatedUnion("type", [
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
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

/** 进程内事件触发器的事件名注册表（spec 2026-09-28-event-trigger-feedback-design §3）；
 * 新事件源（KB 变更/会话完结等）在此追加即可复用整条投递管线。
 * payload 契约见 domain/event-payloads.ts */
export const EVENT_TRIGGER_NAMES = ["feedback.created"] as const;
export type EventTriggerName = (typeof EVENT_TRIGGER_NAMES)[number];

/**
 * bodyRegex 灾难性回溯静态启发式（宁可误杀）。matcher 在事件循环上同步 new RegExp，
 * 一条灾难回溯正则 + 几十字节输入即可冻结整个服务进程。覆盖三类经典形态：
 * 1. 内含量词（加号/星号/{n,}）的分组整体再接量词：(a+)+、(?:\d+)*、(a{2,}){3}
 * 2. 含交替且分支间存在前缀重叠的分组再接量词：(a|aa)+、(x|xy)*（分支重叠才回溯爆炸）
 * 3. 超长 pattern（大于 256 字符的匹配意图本身可疑）
 */
function isReDoSSuspect(pattern: string): boolean {
  if (pattern.length > 256) return true;
  const quantifier = String.raw`(?:[+*]|\{\d*,?\d*\})`;
  // 形态 1：组内含 +/*/开放区间 {n,}，组整体再接量词
  if (new RegExp(String.raw`\([^()]*[+*][^()]*\)\s*${quantifier}`).test(pattern)) return true;
  if (new RegExp(String.raw`\([^()]*\{\d+,\}[^()]*\)\s*${quantifier}`).test(pattern)) return true;
  // 形态 2：交替分支前缀重叠或等值（近似：剥非捕获前缀与量词字符后比对）
  const quantifiedGroups = pattern.matchAll(
    new RegExp(String.raw`\(([^()]*)\)\s*${quantifier}`, "g"),
  );
  for (const m of quantifiedGroups) {
    const content = (m[1] ?? "").replace(/^\?:/, "");
    if (!content.includes("|")) continue;
    const branches = content.split("|").map((b) => b.replace(/[+*?{}[\]]/g, "").trim());
    for (let i = 0; i < branches.length; i++) {
      for (let j = 0; j < branches.length; j++) {
        if (i === j) continue;
        const shorter = branches[i] ?? "";
        const longer = branches[j] ?? "";
        if (shorter.length < 1) continue;
        // 等值分支（(a|a)*）与前缀重叠分支（(a|aa)+）均为回溯爆炸形态
        if (longer === shorter || (longer.length > shorter.length && longer.startsWith(shorter))) {
          return true;
        }
      }
    }
  }
  return false;
}

export const TriggerMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({ kind: z.literal("statusEq"), value: z.number() }),
  // ponytail: 仅支持 $.a.b.c 点路径；bracket/wildcard 等需要时换 jsonpath-plus
  z.object({
    kind: z.literal("jsonPathEq"),
    path: z.string().regex(/^\$\.[a-zA-Z0-9_.]+$/, "仅支持 $.a.b.c 形式"),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("jsonPathGt"),
    path: z.string().regex(/^\$\.[a-zA-Z0-9_.]+$/, "仅支持 $.a.b.c 形式"),
    value: z.number(),
  }),
  z.object({ kind: z.literal("bodyContains"), keyword: z.string() }),
  z.object({
    kind: z.literal("bodyRegex"),
    pattern: z.string().refine((p) => !isReDoSSuspect(p), "正则含嵌套量词（灾难回溯风险），已拒绝"),
  }),
  z.object({ kind: z.literal("bodyFieldEq"), field: z.string(), value: z.string() }),
  z.object({ kind: z.literal("headerEq"), header: z.string(), value: z.string() }),
]);
export type TriggerMatcher = z.infer<typeof TriggerMatcherSchema>;

export const TriggerSchedulerConfigSchema = z.object({
  cron: z.string().min(1),
  source: TriggerSourceSchema,
  matcher: TriggerMatcherSchema,
});
export type TriggerSchedulerConfig = z.infer<typeof TriggerSchedulerConfigSchema>;

export const TriggerHookConfigSchema = z.object({
  path: z.string().regex(/^\/hooks\/[a-z0-9-_]+$/i, "must be /hooks/<slug>"),
  responseStatus: z.number().int().min(100).max(599).default(200),
  responseBody: z.string().default(""),
  matcher: TriggerMatcherSchema,
});
export type TriggerHookConfig = z.infer<typeof TriggerHookConfigSchema>;

/** event 触发器：订阅注册表中的进程内事件，matcher 判定事件 payload JSON */
export const TriggerEventConfigSchema = z.object({
  name: z.enum(EVENT_TRIGGER_NAMES),
  matcher: TriggerMatcherSchema,
});
export type TriggerEventConfig = z.infer<typeof TriggerEventConfigSchema>;

const TriggerBaseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  type: z.enum(["scheduler", "hook", "event"]),
  scheduler: TriggerSchedulerConfigSchema.optional(),
  hook: TriggerHookConfigSchema.optional(),
  event: TriggerEventConfigSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ponytail: DRY——schema 和 input schema 用同一 refine，避免维护双写
function triggerTypeRefine(
  t: { type: string; scheduler?: unknown; hook?: unknown; event?: unknown },
  ctx: z.RefinementCtx,
) {
  if (t.type === "scheduler" && !t.scheduler) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scheduler 类型必须提供 scheduler 配置" });
  }
  if (t.type === "hook" && !t.hook) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "hook 类型必须提供 hook 配置" });
  }
  if (t.type === "event" && !t.event) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event 类型必须提供 event 配置" });
  }
}

export const TriggerInputSchema = TriggerBaseSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).superRefine(triggerTypeRefine);
export type TriggerInput = z.infer<typeof TriggerInputSchema>;

export const TriggerSchema = TriggerBaseSchema.superRefine(triggerTypeRefine);
export type Trigger = z.infer<typeof TriggerSchema>;

export function parseTriggerInput(raw: unknown): TriggerInput {
  return TriggerInputSchema.parse(raw);
}
