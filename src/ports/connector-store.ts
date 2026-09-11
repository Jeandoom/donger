// 连接器端口：HTTP MCP server 的注册表。headers 加密落库，解密仅运行时/测试链路；
// agent 引用（connectorIds）的可见性与重名校验在服务层（web/runtime），端口只管实体本身。

import type { Connector, ConnectorInput } from "../domain/connector.js";

export interface ConnectorStore {
  migrate(): void;

  /** 当前用户可见的全部连接器：本人 private + 他人/本人 global，按 updatedAt 倒序 */
  listForUser(userId: string): Promise<Connector[]>;
  /** 按 id 批量取（运行时按 agent.connectorIds 解析；可见性由调用方校验） */
  listByIds(ids: string[]): Promise<Connector[]>;
  getById(id: string): Promise<Connector | undefined>;
  /** owner 私有域内重名探测（创建/改名前的 409 预检） */
  getByOwnerAndName(ownerId: string, name: string): Promise<Connector | undefined>;

  create(input: ConnectorInput, ownerId: string): Promise<Connector>;
  /** 全量替换（headers 由调用方合并掩码后再传）；不存在抛 NotFoundError */
  update(id: string, input: ConnectorInput): Promise<Connector>;
  delete(id: string): Promise<void>;
}
