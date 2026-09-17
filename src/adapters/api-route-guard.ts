import type { AccessRule, Viewer } from "../domain/access-policy.js";
import { canAccess } from "../domain/access-policy.js";

/** HTTP 方法（路由守卫表用） */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * 路由守卫表条目：每条 /api 路由的显式访问规则声明。
 *  - pattern 精确匹配（支持 :param 段），不做前缀匹配——fail-closed：
 *    未登记的 /api 请求一律 404，新端点忘登记上线即暴露（功能 404）而非越权 200。
 *  - owner 规则必须提供 loadOwner（从 :id 参数解析属主）；资源不存在统一 404 防存在性泄漏。
 */
export interface RouteGuardSpec {
  method: HttpMethod | "*";
  /** 形如 /api/conversations/:id/messages；段集仅允许 [A-Za-z0-9._-] 与 :param */
  pattern: string;
  access: AccessRule;
  loadOwner?: (id: string) => Promise<{ ownerId: string } | undefined>;
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403 | 404; error: string };

interface CompiledSpec extends RouteGuardSpec {
  re: RegExp;
  paramNames: string[];
}

const SEGMENT_SAFE = /^[\w.-]+$/;

/** 编译路由模式为全匹配正则；:xxx 段捕获为参数 */
function compilePattern(pattern: string): { re: RegExp; paramNames: string[] } {
  if (!pattern.startsWith("/") || pattern.includes("//")) {
    throw new Error(`非法 pattern: ${pattern}`);
  }
  const paramNames: string[] = [];
  // pattern 以 / 开头，split 首段为空串属正常形态，跳过首段校验
  const segments = pattern.split("/").slice(1);
  const source = segments
    .map((seg) => {
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (!SEGMENT_SAFE.test(name)) throw new Error(`非法参数名: ${seg} (${pattern})`);
        paramNames.push(name);
        return "([\\w.-]+)";
      }
      if (!SEGMENT_SAFE.test(seg)) throw new Error(`非法路径段: ${seg} (${pattern})`);
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^/${source}/?$`), paramNames };
}

/**
 * API 路由守卫：授权单点收口（设计规格 docs/superpowers/specs/2026-09-17-security-architecture-hardening.md §3）。
 * 构造期 fail-fast（模式非法 / owner 缺 loadOwner / 重复登记），运行期 fail-closed（未匹配 404）。
 */
export class ApiRouteGuard {
  private readonly specs = new Map<string, CompiledSpec>();

  constructor(specs: RouteGuardSpec[]) {
    for (const spec of specs) {
      if (spec.access.kind === "owner" && !spec.loadOwner) {
        throw new Error(`owner 规则缺 loadOwner: ${spec.method} ${spec.pattern}`);
      }
      if (spec.access.kind !== "owner" && spec.loadOwner) {
        throw new Error(`仅 owner 规则可配 loadOwner: ${spec.method} ${spec.pattern}`);
      }
      const key = `${spec.method} ${spec.pattern}`;
      if (this.specs.has(key)) {
        throw new Error(`路由重复登记: ${key}`);
      }
      const { re, paramNames } = compilePattern(spec.pattern);
      if (spec.access.kind === "owner" && paramNames.length !== 1) {
        throw new Error(`owner 规则要求恰好一个 :id 参数: ${spec.pattern}`);
      }
      this.specs.set(key, { ...spec, re, paramNames });
    }
  }

  /** 登记条目数（启动自检/测试用） */
  get size(): number {
    return this.specs.size;
  }

  /** 路由是否已登记（路由覆盖扫描/健康检查用；不含认证态判定） */
  matches(method: string, pathname: string): boolean {
    return this.match(method, pathname) !== undefined;
  }

  /**
   * 守卫判定。viewer 由调用方经 authMiddleware 解析（无 sessionStore 的本地免认证模式
   * 由装配层给全权 viewer）。loadOwner 查询在匹配后按需执行。
   */
  async check(args: {
    method: string;
    pathname: string;
    viewer: Viewer | null;
  }): Promise<GuardResult> {
    const spec = this.match(args.method, args.pathname);
    if (!spec) return { ok: false, status: 404, error: "unknown endpoint" };

    const rule = spec.access;
    if (rule.kind === "public") return { ok: true };
    if (args.viewer === null) return { ok: false, status: 401, error: "请先登录" };
    if (rule.kind === "authenticated") return { ok: true };
    if (rule.kind === "admin") {
      return canAccess(args.viewer, rule)
        ? { ok: true }
        : { ok: false, status: 403, error: "forbidden: 仅管理员" };
    }
    // owner：解析属主 → 判定
    const id = this.extractParam(spec, args.pathname);
    const resource = await spec.loadOwner?.(id);
    if (!resource) return { ok: false, status: 404, error: "not found" };
    if (!canAccess(args.viewer, rule, resource.ownerId)) {
      return { ok: false, status: 403, error: "forbidden: 仅资源属主可访问" };
    }
    return { ok: true };
  }

  private match(method: string, pathname: string): CompiledSpec | undefined {
    for (const spec of this.specs.values()) {
      if (spec.method !== "*" && spec.method !== method) continue;
      if (spec.re.test(pathname)) return spec;
    }
    return undefined;
  }

  private extractParam(spec: CompiledSpec, pathname: string): string {
    const m = spec.re.exec(pathname);
    return m?.[1] ?? "";
  }
}
