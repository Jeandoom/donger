import type { Workflow, WorkflowInput } from "../domain/workflow.js";

export interface WorkflowStore {
  migrate(): void;
  create(input: WorkflowInput): Promise<Workflow>;
  get(id: string): Promise<Workflow | undefined>;
  listByOwner(ownerId: string): Promise<Workflow[]>;
  /** 全量（跨 owner 统计用） */
  listAll(): Promise<Workflow[]>;
  update(id: string, patch: Partial<WorkflowInput>): Promise<Workflow>;
  delete(id: string): Promise<void>;
  /** 启用/停用（原 Loop.setEnabled 迁移落点） */
  setEnabled(id: string, enabled: boolean): Promise<Workflow>;
  /** 运行态回写（lastRunId/lastRunAt/lastError） */
  updateRuntimeState(
    id: string,
    patch: Partial<Pick<Workflow, "lastRunId" | "lastRunAt" | "lastError">>,
  ): Promise<void>;
  /** 某事件的启用订阅者（fire 扇出用） */
  listEnabledByEvent(eventId: string): Promise<Workflow[]>;
  /** 各事件启用订阅计数（事件列表徽标；一条 GROUP BY） */
  countEnabledByEvent(): Promise<Map<string, number>>;
  /** 统计引用某智能体的工作流数（删除智能体前防护悬空引用） */
  countByAgentId(agentId: string): Promise<number>;
  /** 统计订阅某事件的工作流数（删除事件前防护，409） */
  countByEventId(eventId: string): Promise<number>;
}
