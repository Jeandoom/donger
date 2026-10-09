import { z } from "zod";

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

export interface MatcherContext {
  httpStatus?: number;
  headers?: Record<string, string>;
  body: string;
}
export interface MatchResult {
  matched: boolean;
  debug?: unknown;
  error?: string;
}

// ponytail: 极简 JSONPath，仅支持 $.a.b.c 形式（< 10 行，不引 jsonpath 库；
// 未来需要 bracket/wildcard 再换 jsonpath-plus）
function getPath(obj: unknown, path: string): unknown {
  if (!path.startsWith("$.")) return undefined;
  let cur: unknown = obj;
  for (const seg of path.slice(2).split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ponytail: 防 ReDoS——超过 256KB 的 body 不跑用户正则；本地 admin 场景够用
const REGEX_BODY_MAX = 256 * 1024;

export function evaluateMatcher(m: TriggerMatcher, ctx: MatcherContext): MatchResult {
  switch (m.kind) {
    case "always":
      return { matched: true };
    case "statusEq":
      return { matched: ctx.httpStatus === m.value, debug: { status: ctx.httpStatus } };
    case "bodyContains":
      return { matched: ctx.body.includes(m.keyword), debug: { keyword: m.keyword } };
    case "bodyRegex": {
      if (ctx.body.length > REGEX_BODY_MAX) {
        return { matched: false, error: `body exceeds ${REGEX_BODY_MAX} bytes; regex skipped` };
      }
      let re: RegExp;
      try {
        re = new RegExp(m.pattern);
      } catch (e) {
        return { matched: false, error: `regex invalid: ${(e as Error).message}` };
      }
      return { matched: re.test(ctx.body), debug: { pattern: m.pattern } };
    }
    case "headerEq": {
      const v = ctx.headers?.[m.header.toLowerCase()];
      return { matched: v === m.value, debug: { header: m.header, got: v } };
    }
    case "bodyFieldEq":
    case "jsonPathEq":
    case "jsonPathGt": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ctx.body);
      } catch (e) {
        return { matched: false, error: `json parse failed: ${(e as Error).message}` };
      }
      const path = m.kind === "bodyFieldEq" ? `$.${m.field}` : m.path;
      const val = getPath(parsed, path);
      if (m.kind === "jsonPathGt") {
        return { matched: typeof val === "number" && val > m.value, debug: { path, value: val } };
      }
      return { matched: String(val) === String(m.value), debug: { path, value: val } };
    }
  }
}
