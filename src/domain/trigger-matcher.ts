import type { TriggerMatcher } from "./trigger.js";

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
