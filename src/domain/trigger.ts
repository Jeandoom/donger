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

export const TriggerMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }),
  z.object({ kind: z.literal("statusEq"), value: z.number() }),
  z.object({ kind: z.literal("jsonPathEq"), path: z.string(), value: z.string() }),
  z.object({ kind: z.literal("jsonPathGt"), path: z.string(), value: z.number() }),
  z.object({ kind: z.literal("bodyContains"), keyword: z.string() }),
  z.object({ kind: z.literal("bodyRegex"), pattern: z.string() }),
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

const TriggerBaseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  type: z.enum(["scheduler", "hook"]),
  scheduler: TriggerSchedulerConfigSchema.optional(),
  hook: TriggerHookConfigSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TriggerInputSchema = TriggerBaseSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).superRefine((t, ctx) => {
  if (t.type === "scheduler" && !t.scheduler) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scheduler 类型必须提供 scheduler 配置" });
  }
  if (t.type === "hook" && !t.hook) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "hook 类型必须提供 hook 配置" });
  }
});
export type TriggerInput = z.infer<typeof TriggerInputSchema>;

export const TriggerSchema = TriggerBaseSchema.superRefine((t, ctx) => {
  if (t.type === "scheduler" && !t.scheduler) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scheduler 类型必须提供 scheduler 配置" });
  }
  if (t.type === "hook" && !t.hook) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "hook 类型必须提供 hook 配置" });
  }
});
export type Trigger = z.infer<typeof TriggerSchema>;

export function parseTriggerInput(raw: unknown): TriggerInput {
  return TriggerInputSchema.parse(raw);
}
