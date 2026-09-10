import type { Workflow, WorkflowInput } from "../domain/workflow.js";

export interface WorkflowStore {
  migrate(): void;
  create(input: WorkflowInput): Promise<Workflow>;
  get(id: string): Promise<Workflow | undefined>;
  listByOwner(ownerId: string): Promise<Workflow[]>;
  update(id: string, patch: Partial<WorkflowInput>): Promise<Workflow>;
  delete(id: string): Promise<void>;
  /** 统计引用某智能体的工作流数（删除智能体前防护悬空引用） */
  countByAgentId(agentId: string): Promise<number>;
}
