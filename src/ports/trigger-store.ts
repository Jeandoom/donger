import type { Trigger, TriggerInput } from "../domain/trigger.js";

export interface TriggerStore {
  migrate(): void;
  create(input: TriggerInput): Promise<Trigger>;
  get(id: string): Promise<Trigger | undefined>;
  listByOwner(ownerId: string): Promise<Trigger[]>;
  listAll(): Promise<Trigger[]>;
  findByHookPath(path: string): Promise<Trigger | undefined>;
  update(id: string, patch: Partial<TriggerInput>): Promise<Trigger>;
  delete(id: string): Promise<void>;
  /** 返回引用此 trigger 的 workflow 数（用于删除保护） */
  countWorkflowsReferencing(triggerId: string): Promise<number>;
}
