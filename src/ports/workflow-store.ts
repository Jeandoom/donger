import type { Workflow, WorkflowInput } from "../domain/workflow.js";

export interface WorkflowStore {
  migrate(): void;
  create(input: WorkflowInput): Promise<Workflow>;
  get(id: string): Promise<Workflow | undefined>;
  listByOwner(ownerId: string): Promise<Workflow[]>;
  update(id: string, patch: Partial<WorkflowInput>): Promise<Workflow>;
  delete(id: string): Promise<void>;
}
