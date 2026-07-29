import type { Loop, LoopInput, LoopRun } from "../domain/loop.js";

export interface LoopStore {
  migrate(): void;
  // LOOP
  create(input: LoopInput): Promise<Loop>;
  get(id: string): Promise<Loop | undefined>;
  listByOwner(ownerId: string): Promise<Loop[]>;
  listEnabled(): Promise<Loop[]>;
  update(id: string, patch: Partial<LoopInput>): Promise<Loop>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<Loop>;
  updateRuntimeState(
    id: string,
    patch: Partial<Pick<Loop, "lastRunId" | "lastRunAt" | "nextRunAt" | "lastError">>,
  ): Promise<void>;
  // LoopRun
  createRun(run: Omit<LoopRun, "finishedAt">): Promise<LoopRun>;
  updateRun(id: string, patch: Partial<LoopRun>): Promise<void>;
  getRun(id: string): Promise<LoopRun | undefined>;
  listRuns(loopId: string, opts?: { limit?: number; before?: string }): Promise<LoopRun[]>;
}
