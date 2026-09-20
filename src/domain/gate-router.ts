import type { Gate } from "./types.js";

/** 门规则：某工具（可选命令正则）→ 某审批门 */
export interface GateRule {
  gateId: string;
  toolName: string;
  commandPattern?: RegExp;
  /**
   * force 门：full_access 权限模式也不豁免（仍走审批卡）。
   * 自我迭代智能体的安全前提——admin 切 full_access 后 git-write/deploy/authoring
   * 门不得失效（specs/2026-09-17-agent-self-deploy-design.md §3.6）。
   */
  force?: boolean;
}

export interface GateMatch {
  gateId: string;
  /** 命中的规则是否 force 门（full_access 不豁免） */
  force?: boolean;
}

/** 把「工具调用」映射到「审批门」的纯逻辑。 */
export class GateRouter {
  private readonly gates = new Map<string, Gate>();
  private readonly rules: GateRule[] = [];

  /** 注册门元数据（供审批卡标题等） */
  describe(gate: Gate): void {
    this.gates.set(gate.id, gate);
  }

  add(rule: GateRule): void {
    this.rules.push(rule);
  }

  getGate(id: string): Gate | undefined {
    return this.gates.get(id);
  }

  /** 按 add 顺序找首条匹配：工具名相等；若有 commandPattern 则须匹配 input.command */
  match(toolName: string, input: Record<string, unknown>): GateMatch | undefined {
    const command = typeof input.command === "string" ? input.command : "";
    for (const rule of this.rules) {
      if (rule.toolName !== toolName) continue;
      if (rule.commandPattern && !rule.commandPattern.test(command)) continue;
      return { gateId: rule.gateId, ...(rule.force ? { force: true } : {}) };
    }
    return undefined;
  }
}
