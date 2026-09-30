// 主机资产存储端口。实现：adapters/sqlite-host-store.ts。

import type { Host, HostInput } from "../domain/host.js";

export interface HostStore {
  migrate(): void;
  create(input: HostInput, ownerId: string): Promise<Host>;
  get(id: string): Promise<Host | undefined>;
  /** 全量（挂载判定/管理面用）；API 面按 viewer 过滤在 handler 做 */
  listHosts(): Promise<Host[]>;
  update(id: string, patch: Partial<HostInput>): Promise<Host>;
  delete(id: string): Promise<void>;
}
