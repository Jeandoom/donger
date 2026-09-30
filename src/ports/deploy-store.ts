// 部署目标/部署单存储端口。实现：adapters/sqlite-deploy-store.ts。

import type {
  DeployOrder,
  DeployOrderStatus,
  DeployTarget,
  DeployTargetInput,
} from "../domain/deploy.js";

export interface DeployStore {
  migrate(): void;

  createTarget(input: DeployTargetInput, ownerId: string): Promise<DeployTarget>;
  getTarget(id: string): Promise<DeployTarget | undefined>;
  /** 全量（轮询器/挂载判定用）；API 面按 viewer 过滤在 handler 做 */
  listTargets(): Promise<DeployTarget[]>;
  listEnabledTargets(): Promise<DeployTarget[]>;
  updateTarget(id: string, patch: Partial<DeployTargetInput>): Promise<DeployTarget>;
  deleteTarget(id: string): Promise<void>;

  createOrder(order: Omit<DeployOrder, "finishedAt">): Promise<DeployOrder>;
  updateOrder(id: string, patch: Partial<DeployOrder>): Promise<void>;
  getOrder(id: string): Promise<DeployOrder | undefined>;
  listOrders(targetId: string, limit?: number): Promise<DeployOrder[]>;
  /** 最近一次成功部署单（lastDeployedSha 单一真源） */
  getLastSuccessOrder(targetId: string): Promise<DeployOrder | undefined>;
  /** 启动清扫：进程崩溃遗留 running → failed（返回清扫数） */
  failRunningOrders(reason: string): Promise<number>;
}

export type { DeployOrderStatus };
