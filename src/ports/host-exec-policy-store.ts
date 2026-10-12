// 主机执行策略存储端口（specs/2026-10-12-host-exec-policy-design.md §5）：
// admin 治理面 CRUD；orchestrator 轮级快照读取。缺省未装配=回落 agent 级
// hostExecAllowlist 旧行为（部署过渡期安全网）。
import type { HostExecPolicyInput, HostExecPolicyRule } from "../domain/host-exec-policy.js";

export interface HostExecPolicyStore {
  list(): Promise<HostExecPolicyRule[]>;
  get(id: string): Promise<HostExecPolicyRule | undefined>;
  /** 创建（id/时间戳由 store 分配；入参已经 domain Schema 校验） */
  create(input: HostExecPolicyInput, opts?: { createdBy?: string; note?: string }): Promise<HostExecPolicyRule>;
  update(id: string, input: HostExecPolicyInput): Promise<HostExecPolicyRule | undefined>;
  setEnabled(id: string, enabled: boolean): Promise<HostExecPolicyRule | undefined>;
  remove(id: string): Promise<boolean>;
}
