import type { Agent, AgentInput } from "../domain/agent.js";

export interface AgentStore {
  create(input: AgentInput): Promise<Agent>;
  get(id: string): Promise<Agent | undefined>;
  listByOwner(ownerId: string): Promise<Agent[]>;
  listSharedWith(userId: string): Promise<Agent[]>;
  update(id: string, patch: Partial<Agent>): Promise<Agent>;
  delete(id: string): Promise<void>;
}
