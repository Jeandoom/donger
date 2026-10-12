// 存量 agent 白名单 → 主机执行策略 迁移（specs/2026-10-12-host-exec-policy-design.md §8.2）：
// hostExecAllowlist 非空的 agent 各生成一条 agent 作用域 allow 规则（hostCode='*'、
// tool=host_exec、prefix、unattended=inherit——与旧行为逐点等价）。全局标记位幂等：
// 跑过一次后不再重入，admin 删除迁移产物不会被重启复活。字段本身保留在 agent 配置里
// （读路径已退役，仅作迁移来源与历史追溯）。
import type { Agent } from "../domain/agent.js";
import { BUILTIN_DENY_PATTERNS } from "../domain/host-exec-policy.js";
import type { HostExecPolicyStore } from "../ports/host-exec-policy-store.js";

export const LEGACY_HOST_EXEC_MIGRATION_FLAG = "host_exec_policy.legacy_allowlist_migrated_at";
export const BUILTIN_DENY_SEED_FLAG = "host_exec_policy.builtin_deny_seeded_at";

export async function migrateLegacyAgentHostExecAllowlists(deps: {
  agents: { listAll(): Promise<Agent[]> };
  policies: HostExecPolicyStore;
  /** 启动标记位（app_config flag）；缺省=每次启动按 agent 维度幂等重入 */
  flags?: { getFlag(key: string): string | undefined; setFlag(key: string, value: string): void };
  log?: { info(obj: unknown, msg: string): void };
}): Promise<{ migrated: number }> {
  if (deps.flags?.getFlag(LEGACY_HOST_EXEC_MIGRATION_FLAG)) return { migrated: 0 };
  const agents = await deps.agents.listAll();
  // 无标记位时按 agent 维度兜底幂等：已有该 agent 的作用域规则即跳过
  const agentScoped = new Set(
    (await deps.policies.list()).filter((r) => r.scopeKind === "agent").map((r) => r.scopeRef),
  );
  let migrated = 0;
  for (const a of agents) {
    const entries = (a.hostExecAllowlist ?? []).map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0 || agentScoped.has(a.id)) continue;
    await deps.policies.create(
      {
        hostCode: "*",
        tool: "host_exec",
        scopeKind: "agent",
        scopeRef: a.id,
        matchKind: "prefix",
        matchValue: entries.join("\n"),
        decision: "allow",
        unattended: "inherit",
        note: `存量迁移自 agent 白名单（${a.name || a.id}；hostExecAllowlist → 策略表）`,
      },
      { createdBy: "system" },
    );
    migrated++;
  }
  deps.flags?.setFlag(LEGACY_HOST_EXEC_MIGRATION_FLAG, new Date().toISOString());
  if (migrated > 0) {
    deps.log?.info({ migrated }, "agent 白名单已迁移为主机执行策略");
  }
  return { migrated };
}

/**
 * 内置 deny 黑名单种子（specs/2026-10-12 §8.2 M2）：灾难级命令保守精确集，启动播一次
 * （标记位幂等，admin 删除不复活）。宿主机上 mkfs/dd-of-device/关机重启/删根等形态
 * 无歧义毁灭，deny 先行于一切 allow——global allow 规则也不能覆盖。
 */
export async function seedBuiltinDenyRules(deps: {
  policies: HostExecPolicyStore;
  flags?: { getFlag(key: string): string | undefined; setFlag(key: string, value: string): void };
  log?: { info(obj: unknown, msg: string): void };
}): Promise<{ seeded: number }> {
  if (deps.flags?.getFlag(BUILTIN_DENY_SEED_FLAG)) return { seeded: 0 };
  for (const p of BUILTIN_DENY_PATTERNS) {
    await deps.policies.create(
      {
        hostCode: "*",
        tool: "host_exec",
        scopeKind: "global",
        matchKind: "pattern",
        matchValue: p.pattern,
        decision: "deny",
        unattended: "inherit",
        note: p.note,
      },
      { createdBy: "system", note: p.note },
    );
  }
  deps.flags?.setFlag(BUILTIN_DENY_SEED_FLAG, new Date().toISOString());
  deps.log?.info({ seeded: BUILTIN_DENY_PATTERNS.length }, "内置 deny 黑名单已播种");
  return { seeded: BUILTIN_DENY_PATTERNS.length };
}
