import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiRouteGuard } from "../../src/adapters/api-route-guard.js";
import { buildWebRouteGuardSpecs } from "../../src/adapters/web-route-guards.js";

/**
 * 路由覆盖扫描（设计规格 §3.2 lint 兜底）：从 web-channel.ts 源码提取全部 /api 路由
 * 使用点（路径字面量 + 其判定的 HTTP 方法），逐一核对已登记守卫表。
 *
 * 方法感知：GET /api/x 与 POST /api/x 是两条守卫规则，任一命中即覆盖会掩盖漏登记
 * （曾实锤漏掉 GET /api/agents/:id/conversation）。新增端点忘登记时本测试先行变红。
 */

const SRC = join(import.meta.dirname, "..", "..", "src", "adapters", "web-channel.ts");

/** 参数组的 pattern 别名（正则形态 → :param 段） */
const GROUP_ALIASES: Array<[string, string]> = [
  ["([\\w-]+)", ":id"],
  ["([A-Za-z0-9_-]+)", ":token"],
  ["(\\d+)", ":num"],
  ["([^/]+)", ":code"],
];

function restoreGroups(raw: string): string {
  let out = raw.replaceAll("\\/", "/");
  for (const [from, to] of GROUP_ALIASES) out = out.replaceAll(from, to);
  return out;
}

interface RouteUse {
  method: string; // 具体 HTTP 方法；无法静态判定时为 "*"
  pattern: string;
}

/** 提取源码中全部 (method, path) 路由使用点 */
function extractRouteUses(source: string): RouteUse[] {
  const lines = source.split("\n");
  // 只剔除 .startsWith("/api/...") 的参数字符串（前缀判断非精确路由），保留同行其他字面量
  const stripped = lines.map((l) => l.replace(/\.startsWith\(\s*"(\/api\/[^"]*)"\s*\)/g, ""));
  const uses: RouteUse[] = [];

  const methodsIn = (line: string | undefined): string[] =>
    [...(line ?? "").matchAll(/req\.method === "(\w+)"/g)].map((m) => m[1] ?? "");

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i] ?? "";

    // 字符串字面量形态：url === "/api/x"（method 常在同行 || 另一半）
    for (const m of line.matchAll(/"(\/api\/[\w\-./:]+)"/g)) {
      const path = m[1] ?? "";
      if (path.length <= "/api/".length) continue;
      let methods = methodsIn(line);
      if (methods.length === 0) {
        for (const off of [-2, -1, 1, 2]) {
          methods = methodsIn(stripped[i + off]);
          if (methods.length > 0) break;
        }
      }
      for (const method of methods.length > 0 ? methods : ["*"]) {
        uses.push({ method, pattern: path });
      }
    }

    // 正则字面量形态：const xMatch = url.match(/^\/api\/...$/)；method 分支散布其下多行
    for (const m of line.matchAll(/\/\^(\\\/api\\\/[^\n]+?)\$\//g)) {
      const raw = m[1] ?? "";
      if (raw.includes("(?:")) continue;
      const variants = raw.includes("(enable|disable)")
        ? [raw.replace("(enable|disable)", "enable"), raw.replace("(enable|disable)", "disable")]
        : [raw];
      const methods = new Set<string>();
      for (let off = 1; off <= 8; off++) {
        const near = stripped[i + off];
        // 走到下一个路由判断行即停，避免把别家 method 算进来
        if (near && /match\(|url === |pathname === |basePath === /.test(near)) break;
        for (const method of methodsIn(near)) methods.add(method);
      }
      for (const variant of variants) {
        const pattern = restoreGroups(variant);
        for (const method of methods.size > 0 ? methods : ["*"]) {
          uses.push({ method, pattern });
        }
      }
    }
  }
  return uses;
}

describe("路由覆盖扫描：web-channel.ts 中每个 /api 路由使用点都已登记守卫表", () => {
  // 覆盖扫描只核对"登记与否"，不触资源——假 store 满足 owner 规则的 loadOwner 构造校验
  const fakeDeps = {
    conversationStore: { get: async () => ({ userId: "stub" }) },
    taskStore: { get: async () => ({ requesterId: "stub" }) },
    userStore: { get: async () => ({ id: "stub", role: "user" }) },
  } as never;
  const guard = new ApiRouteGuard(buildWebRouteGuardSpecs(fakeDeps));
  const uses = extractRouteUses(readFileSync(SRC, "utf8"));

  it("源码中确实提取到了路由使用点（扫描器自身有效性）", () => {
    expect(uses.length).toBeGreaterThan(40);
  });

  it("每个 (method, path) 使用点都能被守卫表匹配（登记核对）", () => {
    const unregistered: string[] = [];
    for (const { method, pattern } of uses) {
      const concrete = pattern.replaceAll(/:[\w]+/g, "probe-value");
      const hit =
        method === "*"
          ? ["GET", "POST", "PUT", "PATCH", "DELETE"].some((m) => guard.matches(m, concrete))
          : guard.matches(method, concrete);
      if (!hit) unregistered.push(`${method} ${pattern}`);
    }
    expect(unregistered).toEqual([]);
  });

  it("无法还原的正则字面量计数为 0（防扫描静默漏报）", () => {
    const stillGrouped = [...readFileSync(SRC, "utf8").matchAll(/\/\^(\\\/api\\\/[^\n]+?)\$\//g)]
      .map((m) => m[1] ?? "")
      .filter((raw) => !raw.includes("(?:"))
      .flatMap((raw) =>
        raw.includes("(enable|disable)")
          ? [raw.replace("(enable|disable)", "enable"), raw.replace("(enable|disable)", "disable")]
          : [raw],
      )
      .map(restoreGroups)
      .filter((pattern) => /[(+*[\]]/.test(pattern));
    expect(stillGrouped).toEqual([]);
  });
});
