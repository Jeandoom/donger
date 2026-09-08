import type { Agent, AgentInput, AgentVersionSummary } from "../domain/agent.js";

export interface AgentStore {
  create(input: AgentInput): Promise<Agent>;
  get(id: string): Promise<Agent | undefined>;
  listByOwner(ownerId: string): Promise<Agent[]>;
  listSharedWith(userId: string): Promise<Agent[]>;
  update(id: string, patch: Partial<Agent>): Promise<Agent>;
  delete(id: string): Promise<void>;
  /** 版本历史（新→旧）；update 每次生成新版本，rollback 也计入 */
  listVersions(agentId: string): Promise<AgentVersionSummary[]>;
  /** 回滚到指定历史版本：以快照内容做一次 update（生成新版本，历史不破坏） */
  rollback(id: string, version: number): Promise<Agent>;
}
