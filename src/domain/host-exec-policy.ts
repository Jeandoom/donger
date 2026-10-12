// 主机执行策略判定（纯函数+校验）：host_exec / host_logs_clean 免审/审批的可配置治理。
// 背景（2026-10-12 拍板，specs/2026-10-12-host-exec-policy-design.md）：agent 级前缀
// 白名单（host-exec-allowlist）升级为策略表——维度=主机（凭证 code，'*'=全部）×生效域
// （user>agent>role>global）×命令匹配（prefix/pattern）×决策（allow/ask；deny 守卫 M2 接线
// 后放开）。解析顺序 fail-closed：deny 先行于一切 → 主机精确 > '*' → scope 特异度降序 →
// 无命中 = ask（回 host-ops force 门，即旧行为）。判定异常/未命中永不放行。

import { z } from "zod";
import { matchesHostExecAllowlist } from "./host-exec-allowlist.js";

export const HOST_EXEC_POLICY_TOOLS = ["host_exec", "host_logs_clean"] as const;
export type HostExecPolicyTool = (typeof HOST_EXEC_POLICY_TOOLS)[number];

export type HostExecPolicyScopeKind = "global" | "agent" | "user" | "role";
export type HostExecPolicyMatchKind = "prefix" | "pattern";
export type HostExecPolicyDecision = "allow" | "ask" | "deny";
export type HostExecUnattendedMode = "inherit" | "allow" | "skip";

/** 策略规则（表 host_exec_policies 的领域形态） */
export interface HostExecPolicyRule {
  id: string;
  /** 主机凭证 code（kind=host）；'*'=全部主机 */
  hostCode: string;
  /** 生效工具；'*'=两者（host_logs_clean 规则不判定命令内容，按主机/生效域粒度生效） */
  tool: HostExecPolicyTool | "*";
  scopeKind: HostExecPolicyScopeKind;
  /** agent id / user id / role 名；global 为空 */
  scopeRef?: string;
  matchKind: HostExecPolicyMatchKind;
  /** prefix=换行分隔前缀集；pattern=正则 source（对 host_exec 的完整命令 test） */
  matchValue: string;
  decision: HostExecPolicyDecision;
  /** 无人值守轮语义：inherit=跟随 decision；allow=升格放行；skip=跳过（M3 接线） */
  unattended: HostExecUnattendedMode;
  enabled: boolean;
  note?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface HostExecPolicyQuery {
  hostCode: string;
  tool: HostExecPolicyTool;
  /** host_exec=完整命令；host_logs_clean 固定模板不判定内容 */
  command: string;
  agentId?: string;
  userId: string;
  role: string;
  /** 无人值守轮（loop/定时触发） */
  unattended: boolean;
}

export interface HostExecPolicyVerdict {
  decision: "allow" | "skip" | "deny";
  policyId: string;
}

const SCOPE_RANK: Record<HostExecPolicyScopeKind, number> = {
  user: 3,
  agent: 2,
  role: 1,
  global: 0,
};

function ruleMatchesContext(rule: HostExecPolicyRule, q: HostExecPolicyQuery): boolean {
  if (rule.hostCode !== q.hostCode && rule.hostCode !== "*") return false;
  if (rule.tool !== "*" && rule.tool !== q.tool) return false;
  switch (rule.scopeKind) {
    case "global":
      return true;
    case "agent":
      return q.agentId !== undefined && rule.scopeRef === q.agentId;
    case "user":
      return rule.scopeRef === q.userId;
    case "role":
      return rule.scopeRef === q.role;
  }
}

/** pattern 规则的正则缓存（进程级；编译失败=规则失明，视同未命中回审批门） */
const patternCache = new Map<string, RegExp | null>();
function compilePattern(source: string): RegExp | null {
  if (patternCache.has(source)) return patternCache.get(source) ?? null;
  let compiled: RegExp | null = null;
  try {
    if (source.length <= 200) compiled = new RegExp(source);
  } catch {
    compiled = null;
  }
  patternCache.set(source, compiled);
  return compiled;
}

/** 规则的命令匹配：prefix 复用防逃逸口径（组合段逐段命中/替换重定向全拒）；logs_clean 恒中 */
function ruleMatchesCommand(rule: HostExecPolicyRule, q: HostExecPolicyQuery): boolean {
  if (q.tool === "host_logs_clean") return true;
  if (rule.matchKind === "prefix") {
    return matchesHostExecAllowlist(
      q.command,
      rule.matchValue
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  const re = compilePattern(rule.matchValue);
  return re?.test(q.command) === true;
}

/** 生效规则排序键：主机精确 > '*'；同主机内 user > agent > role > global；再按创建时间稳定 */
function specificityDesc(q: HostExecPolicyQuery) {
  return (a: HostExecPolicyRule, b: HostExecPolicyRule): number => {
    const ha = a.hostCode === q.hostCode ? 1 : 0;
    const hb = b.hostCode === q.hostCode ? 1 : 0;
    if (ha !== hb) return hb - ha;
    const sa = SCOPE_RANK[a.scopeKind];
    const sb = SCOPE_RANK[b.scopeKind];
    if (sa !== sb) return sb - sa;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  };
}

/**
 * 策略裁决：命中返回 { decision, policyId }；未命中/异常语义由调用方回审批门（返回 undefined）。
 * deny 先行于一切 allow/ask（黑名单不被 global allow 覆盖）；allow/ask 按
 * 主机×scope 特异度取首条。无人值守轮按条目 unattended 档裁决（inherit=跟随 decision）。
 */
export function resolveHostExecPolicy(
  rules: HostExecPolicyRule[],
  q: HostExecPolicyQuery,
): HostExecPolicyVerdict | undefined {
  const active = rules.filter((r) => r.enabled && ruleMatchesContext(r, q));
  const deny = active
    .filter((r) => r.decision === "deny")
    .filter((r) => ruleMatchesCommand(r, q))
    .sort(specificityDesc(q))[0];
  if (deny) return { decision: "deny", policyId: deny.id };
  const hit = active
    .filter((r) => r.decision === "allow" || r.decision === "ask")
    .filter((r) => ruleMatchesCommand(r, q))
    .sort(specificityDesc(q))[0];
  if (!hit) return undefined;
  if (hit.decision === "allow") {
    if (q.unattended && hit.unattended === "skip") {
      return { decision: "skip", policyId: hit.id };
    }
    return { decision: "allow", policyId: hit.id };
  }
  // ask 条目：无人值守档可升格 allow / 降为 skip；缺省（inherit）维持 ask
  if (q.unattended && hit.unattended === "allow") return { decision: "allow", policyId: hit.id };
  if (q.unattended && hit.unattended === "skip") return { decision: "skip", policyId: hit.id };
  return undefined;
}

// ---------------------------------------------------------------------------
// 管理面输入校验（admin API 用）：M1 决策枚举收窄为 allow|ask、无人值守枚举收窄为
// inherit|allow——deny 守卫（M2）与 skip 接线（M3）落地前不开放，避免配置面与实际行为漂移。
// ---------------------------------------------------------------------------

export const HostExecPolicyInputSchema = z
  .object({
    hostCode: z.string().min(1).max(100),
    tool: z.enum(["*", ...HOST_EXEC_POLICY_TOOLS]),
    scopeKind: z.enum(["global", "agent", "user", "role"]),
    scopeRef: z.string().max(100).optional(),
    matchKind: z.enum(["prefix", "pattern"]),
    matchValue: z.string().min(1).max(6000),
    decision: z.enum(["allow", "ask"]),
    unattended: z.enum(["inherit", "allow"]),
    note: z.string().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scopeKind === "global") {
      if (v.scopeRef) {
        ctx.addIssue({ code: "custom", message: "global 生效域不带 scopeRef" });
      }
    } else if (!v.scopeRef?.trim()) {
      ctx.addIssue({ code: "custom", message: `${v.scopeKind} 生效域必须指定 scopeRef` });
    }
    if (v.matchKind === "prefix") {
      const entries = v.matchValue
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (entries.length === 0) {
        ctx.addIssue({ code: "custom", message: "prefix 规则至少一条前缀" });
      }
      if (entries.length > 100 || entries.some((e) => e.length > 120)) {
        ctx.addIssue({ code: "custom", message: "prefix 规则最多 100 条、单条不超过 120 字符" });
      }
    } else if (v.matchValue.trim().length > 200) {
      ctx.addIssue({ code: "custom", message: "pattern 正则不超过 200 字符" });
    }
  });

export type HostExecPolicyInput = z.infer<typeof HostExecPolicyInputSchema>;

/** pattern 正则可编译性校验（创建/更新时拒收坏正则；运行期编译失败视同未命中） */
export function validatePolicyPattern(source: string): string | undefined {
  if (source.trim().length > 200) return "pattern 正则不超过 200 字符";
  try {
    new RegExp(source);
    return undefined;
  } catch (e) {
    return `正则不可编译：${(e as Error).message}`;
  }
}

/**
 * 系统提示注入素材：按主机分组收集生效的 allow 前缀集（prompt 引导 LLM 在清单内组命令）。
 * hostCodes=当前可见主机凭证清单（'*' 通配规则的条目并入每台具体主机）；存在命中 deny
 * 规则的主机整组不公示（黑名单先行，公示的前缀未必真免审）。unattended 按本轮实况取。
 */
export function collectPromptAllowSections(
  rules: HostExecPolicyRule[],
  hostCodes: string[],
  ctx: { agentId?: string; userId: string; role: string; unattended: boolean },
): Array<{ hostCode: string; prefixes: string[] }> {
  const sections: Array<{ hostCode: string; prefixes: string[] }> = [];
  for (const hostCode of hostCodes) {
    const active = rules.filter((r) => {
      if (!r.enabled || r.tool === "host_logs_clean") return false;
      return ruleMatchesContext(r, { ...ctx, hostCode, tool: "host_exec", command: "" });
    });
    if (active.some((r) => r.decision === "deny")) continue;
    const prefixes = new Set<string>();
    for (const r of active) {
      if (r.decision !== "allow" || r.matchKind !== "prefix") continue;
      if (ctx.unattended && r.unattended === "skip") continue;
      for (const p of r.matchValue
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        prefixes.add(p);
      }
    }
    if (prefixes.size > 0) sections.push({ hostCode, prefixes: [...prefixes] });
  }
  return sections;
}
