/**
 * 「通过并记住」策略落库（热发布 M3 从 runTurn 包装器抽出，spec 2026-10-12 §8.1 M2）：
 * admin 批准 host_exec 且勾选记住 → 前缀落策略表（agent 作用域优先；同型规则已存在则跳过）。
 * 两个调用方：轮内审批决议（orchestrator 包装器）与跨重启审批续跑（resumeAfterApproval）。
 */
import type { Agent } from "../domain/agent.js";
import type { ApprovalRequest } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { validateAdoptPrefix } from "../domain/host-exec-policy.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { HostExecPolicyStore } from "../ports/host-exec-policy-store.js";

export async function adoptHostExecPolicy(deps: {
  hostExecPolicies?: HostExecPolicyStore;
  auditStore?: AuditStore;
  user: User;
  agent?: Agent;
  req: ApprovalRequest;
  conversationId: string;
  taskId: string;
  prefix: string;
}): Promise<void> {
  const { hostExecPolicies, auditStore, user, agent, req, conversationId, taskId, prefix } = deps;
  if (!hostExecPolicies) return;
  if (user.role !== "admin" || req.tool !== "mcp__donger-host__host_exec") return;
  const prefixError = validateAdoptPrefix(prefix);
  const hostCode = typeof req.input.hostCode === "string" ? req.input.hostCode : "";
  if (prefixError || !hostCode) return;
  try {
    const matchValue = prefix.trim();
    const existing = await hostExecPolicies.list();
    const duplicate = existing.some(
      (r) =>
        r.enabled &&
        r.hostCode === hostCode &&
        r.tool === "host_exec" &&
        r.matchKind === "prefix" &&
        r.decision === "allow" &&
        r.scopeKind === (agent ? "agent" : "user") &&
        r.scopeRef === (agent?.id ?? user.id) &&
        r.matchValue === matchValue,
    );
    if (duplicate) return;
    const rule = await hostExecPolicies.create(
      {
        hostCode,
        tool: "host_exec",
        scopeKind: agent ? "agent" : "user",
        scopeRef: agent?.id ?? user.id,
        matchKind: "prefix",
        matchValue,
        decision: "allow",
        unattended: "inherit",
        note: `审批卡一键放行（来源：${String(req.input.command ?? "").slice(0, 120)}）`,
      },
      { createdBy: user.id },
    );
    void auditStore
      ?.record({
        conversationId,
        taskId,
        userId: user.id,
        seq: -1,
        type: "policy_decision",
        text: `审批卡一键成策略：host=${hostCode} policy=${rule.id} prefix=${matchValue}`,
        recordedAt: new Date().toISOString(),
      })
      .catch(() => {});
  } catch {
    // 策略落库失败不阻断已批准的命令执行
  }
}
